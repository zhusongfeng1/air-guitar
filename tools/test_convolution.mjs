/**
 * FFT 卷积验证：和朴素卷积逐点比对。
 *
 *   node tools/test_convolution.mjs
 *
 * 为什么要证：离线示范音频里的混响是靠这个卷积加的，
 * 如果它算错了，你听到的"混响效果"就是假的证据。
 * 朴素卷积的定义不需要信任任何库，所以用它当基准。
 */
import { convolve, fft } from './convolution.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('\n=== FFT 卷积验证 ===\n');

// ---- 朴素卷积（基准，直接按定义算） ----
function naive(sig, ir) {
  const out = new Float64Array(sig.length + ir.length - 1);
  for (let i = 0; i < sig.length; i++) {
    for (let j = 0; j < ir.length; j++) out[i + j] += sig[i] * ir[j];
  }
  return out;
}

/**
 * 相对误差。FFT 的舍入误差会随"结果量级"一起变大（几千项相乘求和之后
 * 结果本身就有几十的量级），拿绝对误差当判据会误报；
 * 相对误差才是"算得对不对"的正确判据。
 *
 * 容差为什么是 FLOAT32_EPS：convolve() 的输出是 Float32Array（写 wav 用），
 * 所以允许的误差上限就是 float32 的舍入精度。
 * 实测各尺寸都在 3e-8 左右（≈ float32 eps 的 1/4），余量够；
 * 真要是算法错了（比如分块叠加偏移算错），误差会是 O(1) 量级，一眼就能抓到。
 */
const FLOAT32_EPS = 1.1920929e-7;

function relErr(a, b) {
  let maxAbs = 0;
  for (let i = 0; i < b.length; i++) maxAbs = Math.max(maxAbs, Math.abs(b[i]));
  let err = 0;
  for (let i = 0; i < b.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
  return { err, maxAbs, rel: maxAbs > 0 ? err / maxAbs : err };
}

// 固定种子，结果可复现
function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}
const mk = (n, seed) => Float64Array.from({ length: n }, rand(seed));

// ---- 1. FFT 本身：往返变换要还原 ----
for (const n of [2, 4, 8, 16, 256, 1024]) {
  const re = mk(n, 7 + n);
  const im = mk(n, 99 + n);
  const origRe = Float64Array.from(re);
  const origIm = Float64Array.from(im);
  fft(re, im, false);
  fft(re, im, true);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - origRe[i]), Math.abs(im[i] - origIm[i]));
  ok(`FFT 往返可还原（n=${n}）`, err < 1e-9, `最大误差 ${err.toExponential(2)}`);
}
ok('FFT 拒绝非 2 的幂长度', (() => {
  try {
    fft(new Float64Array(6), new Float64Array(6), false);
    return false;
  } catch {
    return true;
  }
})());

// ---- 2. 卷积 vs 朴素卷积 ----
const cases = [
  { sig: 64, ir: 16 },
  { sig: 100, ir: 30 },
  { sig: 300, ir: 7 },
  { sig: 1000, ir: 129 },
  { sig: 5000, ir: 777 },
];
for (const c of cases) {
  const sig = mk(c.sig, 11 + c.sig);
  const ir = mk(c.ir, 22 + c.ir);
  const small = convolve(sig, ir, { block: 64 }); // 故意用小分块，逼出跨块叠加的路径
  const ref = naive(sig, ir);
  const e = relErr(small, ref);
  ok(
    `卷积 = 朴素卷积（信号 ${c.sig} × 响应 ${c.ir}，分块 64）`,
    e.rel < FLOAT32_EPS,
    `绝对 ${e.err.toExponential(2)} / 量级 ${e.maxAbs.toFixed(2)} = 相对 ${e.rel.toExponential(2)}`,
  );
  ok(`卷积输出长度正确（${c.sig}+${c.ir}-1=${ref.length}）`, small.length === ref.length, `实际 ${small.length}`);
}

// ---- 3. 脉冲响应比一个分块大很多时也要对（真实场景：1.8s 响应远大于分块）----
{
  const sig = mk(900, 5);
  const ir = mk(3000, 6); // 比分块 256 大得多
  const got = convolve(sig, ir, { block: 256 });
  const ref = naive(sig, ir);
  const e = relErr(got, ref);
  ok(
    '响应跨多个分块时也正确',
    e.rel < FLOAT32_EPS,
    `绝对 ${e.err.toExponential(2)} / 量级 ${e.maxAbs.toFixed(2)} = 相对 ${e.rel.toExponential(2)}`,
  );
}

// ---- 4. 单位脉冲响应 = 原信号 ----
{
  const sig = mk(500, 3);
  const ir = Float64Array.from([1]);
  const got = convolve(sig, ir, { block: 64 });
  let err = 0;
  for (let i = 0; i < sig.length; i++) err = Math.max(err, Math.abs(got[i] - sig[i]));
  ok('和单位脉冲卷积 = 原信号', err < 1e-6, `最大误差 ${err.toExponential(2)}`);
}

// ---- 5. 真实尺寸：混响脉冲响应（1.8 秒）卷积 12 秒音频，验长度和量级 ----
{
  const { impulseData } = await import('../web/js/audio.js');
  const ir = impulseData(44100, 1.8, 2.6)[0];
  const sig = new Float32Array(44100 * 3);
  for (let i = 0; i < sig.length; i++) sig[i] = i === 0 ? 1 : 0; // 单位脉冲
  const got = convolve(sig, ir);
  ok('脉冲卷积脉冲响应 = 脉冲响应本身', Math.abs(got[100] - ir[100]) < 1e-6);
  ok('卷积结果长度 = 3s + 1.8s 的样本数', got.length === sig.length + ir.length - 1, `${got.length}`);
  let tail = 0;
  for (let i = Math.floor(44100 * 2.6); i < got.length; i++) tail = Math.max(tail, Math.abs(got[i]));
  ok('2.6 秒之后尾巴已经衰减到几乎为 0', tail < 1e-3, `尾端最大 ${tail.toExponential(2)}`);
}

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length === 0 ? 0 : 1);
