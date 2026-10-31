/**
 * 用频谱验证示范音频里"和弦"到底响了几个音。
 *
 *   node tools/probe_chroma.mjs
 *
 * 做法：对每段音频算"色度"（12 个音级各自的总能量，扫 MIDI 40..76 的所有八度），
 * 再看能量最高的那几个音级是不是正好等于和弦的组成音。
 * 这是从**音频本身**反推和弦内容，不依赖渲染时用的那份指型表 ——
 * 所以它能独立证明"和弦真的响了多个音"，而不是我拿代码里的定义自己证明自己。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chordIntervals, resolve as resolveChord, noteToMidi } from '../web/js/chords.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function readWav(path) {
  const buf = readFileSync(path);
  let off = 12;
  let data = null;
  let channels = 1;
  let bits = 16;
  let rate = SR;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(data.length / (bits / 8) / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { samples: out, sampleRate: rate };
}

/** 12 音级能量（扫 MIDI 40..76，加汉宁窗） */
function chroma(samples, sampleRate, startSec, durSec) {
  const i0 = Math.floor(startSec * sampleRate);
  const n = Math.min(Math.floor(durSec * sampleRate), samples.length - i0);
  const seg = samples.subarray(i0, i0 + n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const out = new Array(12).fill(0);
  for (let midi = 40; midi <= 76; midi++) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / sampleRate;
    for (let i = 0; i < n; i++) {
      const s = seg[i] * win[i];
      re += s * Math.cos(w * i);
      im -= s * Math.sin(w * i);
    }
    out[midi % 12] += Math.hypot(re, im) / n;
  }
  return out;
}

const { samples, sampleRate } = readWav(join(HERE, '..', 'tutorial', 'demo-和弦对比.wav'));
console.log(`\n读入 demo-和弦对比.wav：${(samples.length / sampleRate).toFixed(1)} 秒 @ ${sampleRate}Hz\n`);

const PROG = ['C', 'G', 'Am', 'F'];
const SPB = 60 / 76;
const LEAD = 0.25;

/** 一段里"和弦音级" vs "非和弦音级"的能量对比 */
function report(title, beat) {
  const t0 = (beat + LEAD) * SPB + 0.08; // 跳过起音，取共振最稳的一段
  const c = chroma(samples, sampleRate, t0, 0.45);
  const total = c.reduce((a, b) => a + b, 0);
  const ranked = c
    .map((v, pc) => ({ pc, name: PC[pc], v }))
    .sort((a, b) => b.v - a.v)
    .map((x, i) => ({ ...x, rank: i + 1, pct: (x.v / total) * 100 }));
  return { ranked, total };
}

let pass = 0;
const fails = [];
// step = 同一段里和弦之间隔几拍（混响那段一小节一个和弦，详见 render_demo.mjs）
// 单音段：只要求"响的那个音是这个和弦的组成音"（现状一次只能响一个音）
// 和弦段（干声）：要求最强的几个音级**正好等于**和弦组成音，一个不多一个不少
// 和弦段（混响）：只要求和弦音都在 —— 前一个和弦的混响尾巴还在响是正常的
for (const [label, base, step, mode] of [
  ['单音（现状）', 0, 2, 'mono'],
  ['和弦齐奏', 8, 2, 'strict'],
  ['和弦+混响', 16, 4, 'loose'],
]) {
  console.log(`──── ${label} ────`);
  PROG.forEach((name, i) => {
    const { ranked } = report(label, base + i * step);
    const shape = resolveChord(name);
    const want = chordIntervals(shape).map((iv) => PC[(noteToMidi(shape.root + '3') + iv) % 12]);
    const top = ranked.slice(0, mode === 'mono' ? 1 : Math.max(want.length, 3));
    const topNames = top.map((x) => x.name);
    // 单音段：响的那一个音必须是和弦音（不能拿"1 个音包含全部和弦音"当天条件）
    // 其余段：和弦音必须都出现在最强的几个音级里
    const good =
      mode === 'mono'
        ? want.includes(topNames[0])
        : mode === 'strict'
          ? want.every((w) => topNames.includes(w)) && topNames.every((t) => want.includes(t))
          : want.every((w) => topNames.includes(w));
    if (good) pass += 1;
    else {
      fails.push(
        `${label} ${name}: 期望 {${want.join(',')}}，实测最强 ${Math.max(want.length, 3)} 个 ${topNames.join(',')}`,
      );
    }
    const bar = ranked
      .slice(0, Math.max(want.length, 3))
      .map((x) => `${x.name}${x.pct.toFixed(0)}%`)
      .join(' ');
    const criteria = mode === 'mono' ? '最响的那个音' : `最强 ${Math.max(want.length, 3)} 个`;
    console.log(`  ${good ? '✓' : '✗'} ${name.padEnd(3)} 期望 {${want.join(' ')}}  ${criteria}：${bar}`);
  });
  console.log('');
}

console.log('判定：');
console.log('  单音段 —— 响的那个音必须是该和弦的组成音（现状一次只能响一个音）');
console.log('  和弦段 —— 最强的几个音级正好等于和弦组成音，一个不多一个不少');
console.log('  混响段 —— 和弦音都要在（混响尾巴里带出前一个和弦的音是正常的）');
console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
