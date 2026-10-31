/**
 * FFT 卷积（重叠相加法）—— 给离线渲染加混响用。
 *
 * 为什么不用朴素卷积：信号 20 秒 × 脉冲响应 1.8 秒 = 87000 × 79000
 * ≈ 69 亿次乘加，纯 JS 要跑好几分钟。FFT 卷积是 O(n log n)。
 *
 * 为什么要用**同一个**脉冲响应（audio.js 的 impulseData）：
 * 否则离线示范听到的混响和网页里听到的不是一回事，示范就失去意义了。
 *
 * 正确性由 tools/test_convolution.mjs 证明：和小规模朴素卷积逐点比对。
 */

/** 原地 FFT / IFFT（长度必须是 2 的幂） */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length) throw new Error('实部虚部长度不一致');
  if (n & (n - 1)) throw new Error(`FFT 长度必须是 2 的幂，实际 ${n}`);

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cwr - xi * cwi;
        const vi = xr * cwi + xi * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * 用脉冲响应卷积一段音频（重叠相加，脉冲响应自动分块）。
 * @param {Float32Array|Float64Array} samples
 * @param {Float32Array|Float64Array} ir
 * @param {{block?:number}} opts block = 每块样本数（内部 FFT 长度是它的 2 倍）
 * @returns {Float32Array} 长度 = samples.length + ir.length - 1
 */
export function convolve(samples, ir, { block = 16384 } = {}) {
  if (!ir.length || !samples.length) return new Float32Array(samples.length + ir.length - 1);
  const L = block;
  const N = L * 2; // 50% 重叠
  const out = new Float64Array(samples.length + ir.length - 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let irStart = 0; irStart < ir.length; irStart += L) {
    // 脉冲响应这一块的频谱（算一次，被所有信号块复用）
    const irRe = new Float64Array(N);
    const irIm = new Float64Array(N);
    for (let i = 0; i < L && irStart + i < ir.length; i++) irRe[i] = ir[irStart + i];
    fft(irRe, irIm, false);

    for (let start = 0; start < samples.length; start += L) {
      // 信号这一块
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < L && start + i < samples.length; i++) re[i] = samples[start + i];
      fft(re, im, false);
      // 频域相乘
      for (let i = 0; i < N; i++) {
        const ar = re[i];
        const ai = im[i];
        re[i] = ar * irRe[i] - ai * irIm[i];
        im[i] = ar * irIm[i] + ai * irRe[i];
      }
      fft(re, im, true);
      // 叠加（注意偏移是 start + irStart）
      const base = start + irStart;
      for (let i = 0; i < N && base + i < out.length; i++) out[base + i] += re[i];
    }
  }
  return Float32Array.from(out);
}
