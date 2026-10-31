/**
 * 把"空弦版"教学里的乐句，用**真实采样**离线渲染成一个 wav，让你先听效果。
 *
 *   node tutorial/render_demo.mjs
 *
 * 为什么要有这个：
 *   1) 它是"这个教学弹出来是什么样"的可听证据 —— 网页里的自动测试只能证明"排进了
 *      播放队列"，不能证明好听；
 *   2) 渲染是确定性的（唯一的随机是几音分的失谐，这里关掉），所以乐谱与音频一一对应；
 *   3) 顺手把每个音的基频用自相关测出来，和乐谱上写的音名对一遍 —— 音高错了会被抓出来。
 *
 * 复刻的是 web/js/audio.js 里的同一套规则（力度分层 / 播放速率 / 包络），
 * 所以听到的就是网页里会响的那个声音。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { convolve } from '../tools/convolution.mjs';
import { impulseData } from '../web/js/audio.js';
import { TUNING, chordIntervals, chordStrings, resolve as resolveChord } from '../web/js/chords.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'web', 'assets', 'guitar');

// ---- 复刻 web/js/audio.js 的纯逻辑（保持一致，改那边记得改这边） ----
const LAYER_THRESHOLDS = [0.45, 0.85];
const pickLayer = (v) => (v < LAYER_THRESHOLDS[0] ? 'pp' : v < LAYER_THRESHOLDS[1] ? 'mf' : 'ff');
const layerGain = (v) => {
  const layer = pickLayer(v);
  const center = layer === 'pp' ? 0.22 : layer === 'mf' ? 0.65 : 1.0;
  return Math.max(0.05, Math.min(1.4, v / center));
};
const playbackRateForFret = (fret, cents = 0) => Math.pow(2, (fret + cents / 100) / 12);
const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteToMidi = (n) => {
  const m = /^([A-G])(#|b)?(-?\d+)$/.exec(n);
  return (Number(m[3]) + 1) * 12 + NOTE_SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
const midiToNote = (n) => `${SHARP[((Math.round(n) % 12) + 12) % 12]}${Math.floor(Math.round(n) / 12) - 1}`;
const transposeNote = (n, s = 0) => midiToNote(noteToMidi(n) + Math.round(s));
const noteToHz = (n) => 440 * Math.pow(2, (noteToMidi(n) - 69) / 12);

// ---- 读 wav（manifest 说是 mono 16bit/44.1k，这里做个防御性解析） ----
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path} 不是 RIFF`);
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path} 缺少 fmt/data 块`);
  const { channels, sampleRate, bits } = fmt;
  if (bits !== 16) throw new Error(`${path} 期望 16bit，实际 ${bits}bit`);
  const n = Math.floor(data.length / 2 / channels);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += data.readInt16LE((i * channels + c) * 2) / 32768;
    mono[i] = acc / channels;
  }
  return { samples: mono, sampleRate };
}

const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
const SR = 44100;
const cache = new Map();
function sampleFor(baseNote, layer) {
  const key = `${baseNote}/${layer}`;
  if (cache.has(key)) return cache.get(key);
  const entry =
    manifest.samples.find((s) => s.note === baseNote && s.dynamic === layer) ||
    manifest.samples.find((s) => s.note === baseNote && s.dynamic === 'mf') ||
    manifest.samples.find((s) => s.note === baseNote);
  if (!entry) throw new Error(`manifest 里没有 ${baseNote} 的采样`);
  const w = readWav(join(ASSETS, entry.file));
  cache.set(key, w);
  return w;
}

const stringNote = (i, transpose) => {
  const o = manifest.openStrings.find((s) => s.index === i);
  return transpose ? transposeNote(o.note, transpose) : o.note;
};

/**
 * 渲染一串事件。
 * @param {{string:number, beat:number, velocity?:number, fret?:number}[]} events beat 是拍数（1 拍 = 60/bpm 秒）
 *   fret = 按在第几品（0 = 空弦）。和弦就是"同一拍上多个 string+fret 事件"。
 * @param {{bpm?:number, transpose?:number, leadInBeats?:number, masterGain?:number}} opts
 */
export function render(events, { bpm = 72, transpose = 0, leadInBeats = 0.25, masterGain = 0.9 } = {}) {
  const spb = 60 / bpm;
  const end = events.reduce((a, e) => {
    const baseNote = manifest.openStrings.find((s) => s.index === e.string).note;
    const rate = playbackRateForFret((e.fret || 0) + transpose);
    return Math.max(
      a,
      (e.beat + leadInBeats) * spb + sampleFor(baseNote, pickLayer(e.velocity ?? 0.7)).samples.length / (SR * rate),
    );
  }, 0);
  const out = new Float32Array(Math.ceil((end + 0.6) * SR));
  const placed = [];

  for (const e of events) {
    const velocity = e.velocity ?? 0.7;
    const layer = pickLayer(velocity);
    const stringIndex = e.string;
    const baseNote = manifest.openStrings.find((s) => s.index === stringIndex).note; // 取哪个 wav
    const { samples, sampleRate } = sampleFor(baseNote, layer);
    const fret = e.fret || 0;
    const semis = fret + transpose; // 按品 + 整体变调，和 audio.js 的 pluck 一致
    const rate = playbackRateForFret(semis);
    const amp = layerGain(velocity) * masterGain;
    const t0 = (e.beat + leadInBeats) * spb;
    const i0 = Math.round(t0 * SR);

    // 包络：和 audio.js 一模一样（持续到 hold，然后衰减到 35%，其后保持）
    const isBass = stringIndex <= 1;
    const hold = isBass ? 0.9 : stringIndex >= 4 ? 0.35 : 0.6;
    const durSec = samples.length / sampleRate;
    const half = durSec / 2;

    const nOut = Math.ceil(samples.length / rate);
    for (let i = 0; i < nOut; i++) {
      const o = i0 + i;
      if (o < 0 || o >= out.length) break;
      const srcPos = i * rate;
      const s0 = Math.floor(srcPos);
      if (s0 + 1 >= samples.length) break;
      const frac = srcPos - s0;
      const s = samples[s0] * (1 - frac) + samples[s0 + 1] * frac;
      const t = i / SR;
      let g;
      if (t <= hold) g = amp;
      else if (t <= half) {
        const k = (t - hold) / Math.max(1e-6, half - hold);
        g = amp * Math.pow(0.35, k); // 近似指数衰减到 35%
      } else g = amp * 0.35;
      out[o] += s * g;
    }
    placed.push({
      string: stringIndex,
      beat: e.beat,
      layer,
      fret,
      note: semis ? transposeNote(baseNote, semis) : baseNote,
      hz: noteToHz(semis ? transposeNote(baseNote, semis) : baseNote),
      timeSec: t0,
    });
  }

  // 归一化到 -1dB 左右，避免削顶（真实播放里是多路叠加，这里为了听感留够余量）
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const norm = peak > 0.89 ? 0.89 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= norm;
  return { samples: out, sampleRate: SR, placed, norm, peak };
}

export function writeWav(path, { samples, sampleRate }) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}

/**
 * 测基频：YIN 的累积均值归一化差值函数（CMNDF）。
 *
 * 一开始用的是朴素自相关，结果 D3 被测成 73.4Hz、G3 被测成 65.3Hz —— 全是"恰好低一个
 * 八度"：自相关在 τ 和 2τ、4τ 上都有峰，衰减信号的长 τ 归一化之后反而更大，于是锁到
 * 了周期倍数上。CMNDF 除以"前 τ 个差值的均值"正好抵消这个偏差，并且**取第一个**
 * 低于阈值的极小值，所以永远优先选最小周期。
 */
export function measureHz(samples, sampleRate, startSec, { minHz = 60, maxHz = 1400, win = 4096, threshold = 0.12 } = {}) {
  const i0 = Math.max(0, Math.round(startSec * sampleRate));
  const seg = samples.subarray(i0, Math.min(samples.length, i0 + win));
  const N = seg.length;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.ceil(sampleRate / minHz), N >> 1);
  if (tauMax <= tauMin) return null;

  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i + tau < N; i++) {
      const diff = seg[i] - seg[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cm = new Float64Array(tauMax + 1);
  cm[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  let bestTau = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] < threshold) {
      while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
      bestTau = tau;
      break;
    }
  }
  if (!bestTau) {
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < m) {
        m = cm[tau];
        bestTau = tau;
      }
    }
  }
  if (!bestTau) return null;

  // 抛物线插值，把周期细分到位
  const y = (t) => (t >= 1 && t <= tauMax ? cm[t] : cm[bestTau]);
  const a = y(bestTau - 1);
  const b = y(bestTau);
  const c = y(bestTau + 1);
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom))) : 0;
  return sampleRate / (bestTau + delta);
}

/**
 * 先证明"渲染器本身是对的"：每根弦、每个变调量，**单独**渲染一个音再测基频。
 *
 * 为什么不直接在叠起来的示范曲里测：弦是连着响的（低音弦余韵很长），
 * 自相关会在混合信号里锁到低音那根弦的周期倍数上，测出来"低一个八度"——
 * 那是测法的锅，不是音的锅。单独渲染 + 单独测量才能干净地证明音高映射。
 */
export function verifyRenderer() {
  console.log('\n=== 渲染器音高自检（每个音单独渲染后测基频） ===');
  let pass = 0;
  let total = 0;
  const rows = [];
  for (const transpose of [0, 5, -2, 7]) {
    for (let string = 0; string < 6; string++) {
      const baseNote = manifest.openStrings.find((s) => s.index === string).note;
      const want = transposeNote(baseNote, transpose);
      const wantHz = noteToHz(want);
      const solo = render([{ string, beat: 0, velocity: 0.8 }], { transpose, leadInBeats: 0, bpm: 72, masterGain: 1 });
      const got = measureHz(solo.samples, SR, 0.06, { minHz: 60, maxHz: 1400 });
      const cents = got ? 1200 * Math.log2(got / wantHz) : NaN;
      const ok = !!got && Math.abs(cents) < 25;
      total += 1;
      if (ok) pass += 1;
      rows.push(
        `  ${ok ? 'ok  ' : 'BAD '} 变调${String(transpose).padStart(3)} 第${string + 1}弦 ${want.padEnd(4)} 期望 ${wantHz
          .toFixed(1)
          .padStart(7)}Hz 实测 ${got ? got.toFixed(1).padStart(7) : '  ---  '}Hz 偏差 ${
          Number.isFinite(cents) ? cents.toFixed(0).padStart(4) : ' ---'
        } 音分`,
      );
    }
  }
  console.log(rows.join('\n'));
  console.log(`  → ${pass}/${total} 通过（±25 音分内）`);
  return { pass, total };
}

// --------------------------------------------------------------------------
// 教学里的示范乐句：4/4 慢速（72bpm），全部只用 6 根空弦
//
// 用 +5 变调 → A2 D3 G3 C4 E4 A4（A 小调的 Am7add11），
// 这是最像"伤感慢歌"的一组音色，所以《我不难过》这一段用它示范。
// --------------------------------------------------------------------------
export const DEMO = {
  name: 'A 小调空弦示范（变调 +5）',
  transpose: 5,
  bpm: 72,
  // 6弦=A2 5弦=D3 4弦=G3 3弦=C4 2弦=E4 1弦=A4
  events: [
    { string: 0, beat: 0.0, velocity: 0.8 }, // A2 低音
    { string: 0, beat: 1.5, velocity: 0.55 },
    { string: 2, beat: 2.0, velocity: 0.6 }, // G3
    { string: 3, beat: 2.5, velocity: 0.6 }, // C4
    { string: 4, beat: 3.0, velocity: 0.7 }, // E4
    { string: 3, beat: 3.5, velocity: 0.5 }, // C4

    { string: 1, beat: 4.0, velocity: 0.8 }, // D3 低音
    { string: 1, beat: 5.5, velocity: 0.5 },
    { string: 4, beat: 6.0, velocity: 0.65 }, // E4
    { string: 3, beat: 6.5, velocity: 0.6 }, // C4
    { string: 2, beat: 7.0, velocity: 0.6 }, // G3
    { string: 3, beat: 7.5, velocity: 0.5 }, // C4

    { string: 0, beat: 8.0, velocity: 0.85 }, // A2
    { string: 5, beat: 8.5, velocity: 0.55 }, // A4 高音点缀
    { string: 4, beat: 9.0, velocity: 0.7 }, // E4
    { string: 2, beat: 9.5, velocity: 0.6 }, // G3
    { string: 3, beat: 10.0, velocity: 0.6 }, // C4
    { string: 2, beat: 10.5, velocity: 0.5 }, // G3
    { string: 4, beat: 11.0, velocity: 0.7 }, // E4
    { string: 1, beat: 11.5, velocity: 0.55 }, // D3

    { string: 0, beat: 12.0, velocity: 0.75 }, // A2 收
    { string: 3, beat: 12.5, velocity: 0.5 },
    { string: 4, beat: 13.0, velocity: 0.6 },
    { string: 5, beat: 13.5, velocity: 0.6 }, // A4
  ],
};

/** 命令行入口：node tutorial/render_demo.mjs */
function main() {
  const verified = verifyRenderer();

  // ------------------------------------------------------------------------
  // 和弦对比示范：同一段走向，先"现状"（一次一个空弦音），再"和弦齐奏"，
  // 最后"和弦齐奏 + 混响"。三段连着听，单调不单调一耳朵就分得出来。
  // ------------------------------------------------------------------------
  const PROG = ['C', 'G', 'Am', 'F']; // 情歌里最常见的四个和弦之一
  const VAL = 0.8;
  const SPREAD = 0.026; // 26ms，和 audio.js 里 strumChord 的 spreadMs 一致

  /** 把和弦展开成"同一拍上多根弦"的事件（模拟扫弦的先后） */
  const chordEvents = (name, beat) =>
    chordStrings(resolveChord(name)).map(({ string, fret }, i) => ({
      string,
      fret,
      beat: beat + (i * SPREAD * 1000) / (60000 / 76), // 26ms 折算成拍
      velocity: VAL,
    }));

  /** 现状：一次只响一个空弦音。规则=从空弦音里挑一个和弦音（优先根音→三度→五度）。
   *  这已经是"现状"能给出的最好结果了 —— 和弦的其它音根本没地方响。 */
  const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const monoPick = (name) => {
    const shape = resolveChord(name);
    const rootPc = noteToMidi(shape.root + '3') % 12;
    const ivs = chordIntervals(shape);
    const third = ivs.find((iv) => iv === 3 || iv === 4);
    const order = [rootPc, ...(third !== undefined ? [(rootPc + third) % 12] : []), (rootPc + 7) % 12];
    for (const want of order) {
      for (let i = 0; i < TUNING.length; i++) {
        if (noteToMidi(TUNING[i]) % 12 === want) return { string: i, tone: PC_NAMES[want] };
      }
    }
    return { string: 0, tone: '?' };
  };
  const monoEvents = (name, beat) => [{ string: monoPick(name).string, beat, velocity: VAL }];

  const events = [];
  PROG.forEach((c, i) => events.push(...monoEvents(c, i * 2))); // 0-7 单音
  PROG.forEach((c, i) => events.push(...chordEvents(c, 8 + i * 2))); // 8-15 和弦
  // 加混响这一段放慢到一小节一个和弦：混响需要空隙，排太密会糊在一起，
  // 而且上一个和弦的余音会盖住下一个（听起来像弹错）
  PROG.forEach((c, i) => events.push(...chordEvents(c, 16 + i * 4))); // 16-31 和弦+混响

  const r = render(events, { bpm: 76 });
  // 只给后三分之一加混响：用和网页完全相同的脉冲响应
  const ir = impulseData(SR, 1.8, 2.6)[0];
  const wet = convolve(r.samples, ir);
  const drySamples = Math.floor((16 + 0.25) * (60 / 76) * SR); // 第 16 拍开始加混响
  const mixed = Float32Array.from(r.samples);
  for (let i = drySamples; i < mixed.length; i++) {
    mixed[i] = r.samples[i] + 0.35 * (wet[i] || 0);
  }
  // 重新归一化
  let peak = 0;
  for (const v of mixed) peak = Math.max(peak, Math.abs(v));
  const norm2 = peak > 0.89 ? 0.89 / peak : 1;
  for (let i = 0; i < mixed.length; i++) mixed[i] *= norm2;

  const outPath = join(HERE, 'demo-和弦对比.wav');
  writeWav(outPath, { samples: mixed, sampleRate: SR });
  console.log('\n=== 和弦对比（现状单音 → 和弦齐奏 → 和弦+混响） → demo-和弦对比.wav ===');
  console.log(`  ${PROG.join(' ')} × 3 遍，${(mixed.length / SR).toFixed(1)} 秒，峰值 ${(peak * norm2).toFixed(3)}`);
  console.log(
    `  第 1 遍（0-7 拍）单音：每次只响 1 个音 —— ${PROG.map((c) => `${c}→${monoPick(c).tone}`).join(' ')}`,
  );
  console.log(`     （现状的极限：F 和弦的空弦音里根本没有 F，只能拿 3 度音顶替）`);
  console.log(`  第 2 遍（8-15 拍）和弦齐奏：每次响 ${chordStrings(resolveChord('C')).length} 根弦`);
  console.log(`  第 3 遍（16-31 拍）和弦齐奏 + 混响（和网页里同一个脉冲响应，一小节一个和弦）`);

  for (const [file, cfg] of [
    ['demo-Aminor.wav', DEMO],
    [
      'demo-Eminor.wav',
      {
        name: '原调空弦示范（变调 0，E 小调 Em11）',
        transpose: 0,
        bpm: 72,
        events: DEMO.events,
      },
    ],
  ]) {
    const r = render(cfg.events, { bpm: cfg.bpm, transpose: cfg.transpose });
    const path = join(HERE, file);
    writeWav(path, r);
    console.log(`\n=== ${cfg.name} → ${file} ===`);
    console.log(`  变调 ${cfg.transpose} 个半音，${cfg.bpm}bpm，${r.placed.length} 个音，${(r.samples.length / SR).toFixed(1)} 秒，峰值 ${(r.peak * r.norm).toFixed(3)}`);
    const beatsPerBar = 4;
    let line = '';
    for (let b = 0; b < 16; b += 0.5) {
      const hit = cfg.events.filter((e) => e.beat === b);
      line += `${b % beatsPerBar === 0 ? '|' : ' '}${hit.map((e) => stringNote(e.string, cfg.transpose)).join('+') || '·'}`;
    }
    console.log(`  弦序（每 0.5 拍一格）：${line}|`);
    console.log(`  音名顺序：${r.placed.map((p) => p.note).join(' ')}`);
  }
  console.log(`\n渲染器音高自检：${verified.pass}/${verified.total}`);
  return verified;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
