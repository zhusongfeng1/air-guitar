/**
 * 逐个量 18 个空弦采样本身（不是量渲染结果）。
 *
 *   node tools/check_samples.mjs
 *
 * 为什么要有这个：以前的"音高自检"量的是**渲染出来的 wav**，而且每根弦只过了
 * 一个力度层 —— 也就是说 18 个素材里，音高只有 6 个被间接验过。
 * 用户反馈"5 弦明显和其他五根不一样"时，我才发现这个盲区：
 * 可能某个力度层的文件根本不是那个音、也可能它的长度/衰减/亮度是异类。
 *
 * 量四件事：
 *   1. 音高（YIN）离标准音差多少音分 —— 超过 ±15 音分人耳就能听出"不准"；
 *   2. 时长 + 衰减（0.05/0.25/0.5/1.0/1.5s 的 RMS）—— 长度差一倍，弹起来就是"这根弦不出声"；
 *   3. 峰值 / RMS —— 响度是不是异类；
 *   4. 频谱重心 —— 音色是亮还是闷（跟同组其它文件比）。
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readWav, measureHz } from '../tutorial/render_demo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// --dir 可以指向别的采样目录，用来验证"这套判据真能抓出旧文件的问题"
const dirArg = process.argv.indexOf('--dir');
const DIR = dirArg >= 0 && process.argv[dirArg + 1]
  ? process.argv[dirArg + 1]
  : join(HERE, '..', 'web', 'assets', 'guitar');
const LAYERS = ['pp', 'mf', 'ff'];
// 6 根空弦的标准音高（弦 0 = 6 弦）
const NOTES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
const STRINGS = ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'];

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteToMidi = (n) => {
  const m = /^([A-G]#?)(-?\d+)$/.exec(n);
  return SHARP.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
};
const midiToNote = (m) => `${SHARP[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

function rms(s, from, to) {
  const a = Math.max(0, Math.floor(from * s.sampleRate));
  const b = Math.min(s.samples.length, Math.floor(to * s.sampleRate));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += s.samples[i] * s.samples[i];
  return Math.sqrt(sum / (b - a));
}

/** 朴素 DFT 求频谱重心（只跑 0~5kHz、bin 步长 2，够用且不改依赖） */
function centroid(s, atSec = 0.12) {
  const N = 2048;
  const start = Math.floor(atSec * s.sampleRate);
  if (start + N > s.samples.length) return null;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = s.samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const df = s.sampleRate / N;
  let num = 0;
  let den = 0;
  for (let k = 1; k * df < 5000; k += 2) {
    const w = (2 * Math.PI * k) / N;
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      re += win[i] * Math.cos(w * i);
      im -= win[i] * Math.sin(w * i);
    }
    const mag = Math.hypot(re, im);
    num += k * df * mag;
    den += mag;
  }
  return den > 0 ? num / den : null;
}

const rows = [];
for (const layer of LAYERS) {
  for (let i = 0; i < NOTES.length; i++) {
    const note = NOTES[i];
    const path = join(DIR, layer, `${note}.wav`);
    let s;
    try {
      s = readWav(path);
    } catch (e) {
      rows.push({ layer, note, i, error: e.message });
      continue;
    }
    const dur = s.samples.length / s.sampleRate;
    let peak = 0;
    for (let k = 0; k < s.samples.length; k++) peak = Math.max(peak, Math.abs(s.samples[k]));
    const hz = measureHz(s.samples, s.sampleRate, 0.06, { minHz: 55, maxHz: 1200, win: 4096 });
    const cents = hz ? 1200 * Math.log2(hz / (440 * Math.pow(2, (noteToMidi(note) - 69) / 12))) : null;
    // 余音指标：0.45~0.65s 处相对 0.03~0.15s 处的电平。
    // 这是唯一能抓出"被闷掉的短音"的量 —— 那种音音高对、峰值对，但 250ms 掉 15dB。
    const atk = rms(s, 0.03, 0.15);
    const late = rms(s, 0.45, 0.65);
    const susDb = atk > 0 && late > 0 ? 20 * Math.log10(late / atk) : -120;
    rows.push({
      layer,
      note,
      i,
      dur,
      peak,
      rms: rms(s, 0, dur),
      hz,
      cents,
      susDb,
      heard: hz ? midiToNote(69 + 12 * Math.log2(hz / 440)) : null,
      env: [0.05, 0.25, 0.5, 1.0, 1.5].map((t) => rms(s, t, t + 0.05)),
      cen: centroid(s),
    });
  }
}

const fmt = (v, n = 1) => (v === null || v === undefined ? '  —' : v.toFixed(n));
console.log(`\n${'层'.padEnd(3)} ${'弦'.padEnd(4)} ${'音'.padEnd(4)} ${'时长'.padEnd(6)} ${'峰值'.padEnd(5)} ${'实测Hz'.padEnd(8)} ${'听到的'.padEnd(7)} ${'音分'.padEnd(6)} ${'余音'.padEnd(7)} ${'亮度'.padEnd(6)} 衰减(0.05/0.25/0.5/1.0/1.5s)`);
for (const r of rows) {
  if (r.error) {
    console.log(`${r.layer.padEnd(3)} ${STRINGS[r.i].padEnd(4)} ${r.note.padEnd(4)} 读取失败：${r.error}`);
    continue;
  }
  const env = r.env.map((v) => fmt(v, 3)).join('/');
  console.log(
    `${r.layer.padEnd(3)} ${STRINGS[r.i].padEnd(4)} ${r.note.padEnd(4)} ${fmt(r.dur, 2).padStart(6)} ` +
      `${fmt(r.peak, 3)} ${fmt(r.hz, 1).padStart(8)} ${String(r.heard).padEnd(7)} ` +
      `${(r.cents === null ? '—' : (r.cents > 0 ? '+' : '') + fmt(r.cents, 0)).padStart(6)} ` +
      `${(r.susDb > -60 ? (r.susDb > 0 ? '+' : '') + fmt(r.susDb, 1) : '—').padStart(7)} ` +
      `${(r.cen === null ? '—' : Math.round(r.cen) + 'Hz').padEnd(6)} ${env}`,
  );
}

// ---- 判定 ----
// 门槛是照着"用户能听出来的毛病"定的，不是照着"数据好看"：
//   音高 ±15 音分：再偏就该听出跑调了；
//   时长 ≥2.3s：吉他空弦余韵本来就该有 2 秒以上，被切成 0.6 秒就是"嗒一声"；
//   余音 ≥-18dB：0.5 秒处相对起音不能掉过 18dB，否则这根弦明显比别的短；
//   同层内余音互差 ≤12dB：这是"五弦和别的五根不一样"的直接判据。
const SUS_MIN = -18.0;
const SUS_SPREAD = 12.0;
const DUR_MIN = 2.3;
let bad = 0;
for (const note of NOTES) {
  for (const layer of LAYERS) {
    const r = rows.find((x) => x.note === note && x.layer === layer);
    if (!r || r.error) {
      console.log(`✗ ${layer}/${note}：读不出来`);
      bad += 1;
      continue;
    }
    if (r.cents === null || Math.abs(r.cents) > 15) {
      console.log(`✗ ${layer}/${note}：音高错（实测 ${r.heard} ${fmt(r.hz, 1)}Hz，差 ${fmt(r.cents, 0)} 音分）`);
      bad += 1;
    }
    if (r.dur < DUR_MIN) {
      console.log(`✗ ${layer}/${note}：太短（${fmt(r.dur, 2)}s < ${DUR_MIN}s）——弹起来会"刚响就断"`);
      bad += 1;
    }
    if (r.susDb < SUS_MIN) {
      console.log(
        `✗ ${layer}/${note}：余音太短（0.5s 处 ${fmt(r.susDb, 1)}dB < ${SUS_MIN}dB）` +
          `——这就是"被手闷掉的短音"，音高对、峰值对，但一弹就没了`,
      );
      bad += 1;
    }
  }
}
// 同层内互相比较：一根弦明显比其它弦短，用户立刻能听出来
for (const layer of LAYERS) {
  const same = rows.filter((r) => r.layer === layer && !r.error);
  const sorted = same.map((r) => r.susDb).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (const r of same) {
    if (median - r.susDb > SUS_SPREAD) {
      console.log(
        `✗ ${layer}/${r.note}：余音比同层其它弦短太多（${fmt(r.susDb, 1)}dB vs 中位 ${fmt(median, 1)}dB）`,
      );
      bad += 1;
    }
  }
}
// 同一根弦的三个力度层长度要一致，否则换力度像换了把琴
for (const note of NOTES) {
  const ds = LAYERS.map((l) => rows.find((x) => x.note === note && x.layer === l)?.dur || 0);
  const ratio = Math.max(...ds) / Math.max(0.001, Math.min(...ds));
  if (ratio > 1.3) {
    console.log(`⚠ ${note}：三个力度层长度差 ${ratio.toFixed(2)} 倍（${ds.map((d) => d.toFixed(2)).join('/')}s）`);
    bad += 1;
  }
}
console.log(
  bad === 0
    ? `\n全部合格（18 个采样：音高 ±15 音分内、时长 ≥${DUR_MIN}s、余音 ≥${SUS_MIN}dB 且同层互差不超 ${SUS_SPREAD}dB）。\n`
    : `\n共 ${bad} 处问题。\n`,
);
process.exit(bad === 0 ? 0 : 1);
