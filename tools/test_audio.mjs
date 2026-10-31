/**
 * 发声逻辑单测（不需要浏览器/扬声器）：
 *   node tools/test_audio.mjs
 *
 * 只测纯逻辑：力度分层、品丝变调、扫弦排期、音名换算。
 * 采样能不能解码是浏览器的事，那个由网页里的 ?selftest=1 验。
 */

import {
  pickLayer,
  layerGain,
  playbackRateForFret,
  pluckSchedule,
  noteToHz,
  noteToMidi,
  midiToNote,
  transposeNote,
  GuitarSampler,
  LAYERS,
} from '../web/js/audio.js';

let pass = 0;
let fail = 0;
const round = (v) => Number(Number(v).toFixed(5));
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('\n[1] 力度 → 采样层');
{
  check('pp/mf/ff 三层', JSON.stringify(LAYERS) === JSON.stringify(['pp', 'mf', 'ff']));
  check('0.10 → pp', pickLayer(0.1) === 'pp');
  check('0.44 → pp', pickLayer(0.44) === 'pp');
  check('0.45 → mf（阈值归上层）', pickLayer(0.45) === 'mf');
  check('0.80 → mf', pickLayer(0.8) === 'mf');
  check('0.85 → ff', pickLayer(0.85) === 'ff');
  check('1.00 → ff', pickLayer(1) === 'ff');
  check('越界钳位', pickLayer(-5) === 'pp' && pickLayer(9) === 'ff');
}

console.log('\n[2] 层内音量补偿（层与层之间不要忽大忽小）');
{
  check('层中心处增益 = 1', approx(layerGain(0.22), 1, 0.01) && approx(layerGain(0.65), 1, 0.01) && approx(layerGain(1.0), 1, 0.01));
  check('单调不减', layerGain(0.1) <= layerGain(0.5) && layerGain(0.5) <= layerGain(0.9));
  check('不会超过 1.4', layerGain(1) <= 1.4 && layerGain(0.9) <= 1.4);
}

console.log('\n[3] 品丝变调');
{
  check('空弦 = 原速 1.0', approx(playbackRateForFret(0), 1));
  check('12 品 = 2 倍（高八度）', approx(playbackRateForFret(12), 2, 1e-9));
  check('低 12 品 = 0.5 倍', approx(playbackRateForFret(-12), 0.5, 1e-9));
  check('2 品 = 2^(1/6)', approx(playbackRateForFret(2), Math.pow(2, 1 / 6), 1e-9));
  check('100 音分 = 1 个半音', approx(playbackRateForFret(0, 100), Math.pow(2, 1 / 12), 1e-9));
}

console.log('\n[4] 扫弦排期');
{
  const down = pluckSchedule([5, 2, 0], { spreadMs: 35, down: true });
  check(
    '下扫按低音弦 → 高音弦',
    JSON.stringify(down.map((d) => d.string)) === JSON.stringify([0, 2, 5]),
    JSON.stringify(down),
  );
  check('间隔 35ms 递增', JSON.stringify(down.map((d) => d.offsetMs)) === JSON.stringify([0, 35, 70]));
  const up = pluckSchedule([0, 2, 5], { spreadMs: 20, down: false });
  check('上扫反过来', JSON.stringify(up.map((d) => d.string)) === JSON.stringify([5, 2, 0]));
  check('单弦偏移为 0', pluckSchedule([3])[0].offsetMs === 0);
  check('不改原数组', (() => {
    const src = [5, 0, 2];
    pluckSchedule(src);
    return JSON.stringify(src) === JSON.stringify([5, 0, 2]);
  })());
}

console.log('\n[5] 音名 → 频率（和采样清单里的目标值对上）');
{
  const want = { E2: 82.41, A2: 110.0, D3: 146.83, G3: 196.0, B3: 246.94, E4: 329.63 };
  for (const [note, hz] of Object.entries(want)) {
    check(`${note} = ${hz} Hz`, approx(noteToHz(note), hz, 0.01), noteToHz(note).toFixed(2));
  }
  check('A4 = 440', approx(noteToHz('A4'), 440, 1e-9));
  check('Gb5 = 739.99', approx(noteToHz('Gb5'), 739.99, 0.01));
  check('乱写会抛错', (() => {
    try {
      noteToHz('H9');
      return false;
    } catch {
      return true;
    }
  })());
}

console.log('\n[8] 闷音 / 解除闷音（拨弦必须先把闷音解除，否则起音被吃掉）');
{
  // 用一个最小的 AudioParam 假件，验证 unmute 的排期
  const calls = [];
  const fakeParam = {
    value: 0.9,
    cancelScheduledValues: (t) => calls.push(['cancel', t]),
    setValueAtTime: (v, t) => calls.push(['set', round(v), round(t)]),
    linearRampToValueAtTime: (v, t) => calls.push(['ramp', round(v), round(t)]),
  };
  const ctx = { currentTime: 5, createGain: () => ({ gain: fakeParam, connect: () => {}, }) };
  const s = Object.create(GuitarSampler.prototype);
  s.ctx = ctx;
  s.master = { gain: fakeParam };

  calls.length = 0;
  s.mute(0.06);
  check('mute：先把音量压到 0.0001', calls.some((c) => c[0] === 'ramp' && c[1] === 0.0001), JSON.stringify(calls));
  check('mute：随后恢复到 0.9', calls.some((c) => c[0] === 'set' && c[1] === 0.9), JSON.stringify(calls));

  calls.length = 0;
  s.unmute(0.012);
  check('unmute：立刻线性恢复到 0.9', calls.some((c) => c[0] === 'ramp' && c[1] === 0.9), JSON.stringify(calls));
  check('unmute：取消之前排的闷音动作', calls[0][0] === 'cancel', JSON.stringify(calls));
}

console.log('\n[9] 整体变调：整把琴平移，用来对上歌曲的调');
{
  // 空弦 E A D G B E，验证平移后的音名
  check('E2 +5 → A2', transposeNote('E2', 5) === 'A2');
  check('A2 +5 → D3', transposeNote('A2', 5) === 'D3');
  check('D3 +5 → G3', transposeNote('D3', 5) === 'G3');
  check('G3 +5 → C4', transposeNote('G3', 5) === 'C4');
  check('B3 +5 → E4', transposeNote('B3', 5) === 'E4');
  check('E4 +5 → A4', transposeNote('E4', 5) === 'A4');
  check('E2 -2 → D2', transposeNote('E2', -2) === 'D2');
  check('E2 -3 → C#2', transposeNote('E2', -3) === 'C#2');
  check('+7：E2 → B2', transposeNote('E2', 7) === 'B2');
  check('B3 +2 → C#4（跨八度进位）', transposeNote('B3', 2) === 'C#4');
  check('B3 +1 → C4', transposeNote('B3', 1) === 'C4');
  check('±0 不变', transposeNote('E2', 0) === 'E2');
  check('+12 高八度', transposeNote('E2', 12) === 'E2'.replace('2', '3'));
  check('-12 低八度', transposeNote('E4', -12) === 'E3');
  check('+5 再 -5 回到原样',
    transposeNote(transposeNote('E2', 5), -5) === 'E2');
  // 频率也要跟着对：A2 = 110Hz
  check('变调后的音名算出来的频率是对的（A2=110Hz）', approx(noteToHz('A2'), 110, 0.01));
  check('E2 = 82.41Hz', approx(noteToHz('E2'), 82.41, 0.01));
  check('1弦 E4 = 329.63Hz', approx(noteToHz('E4'), 329.63, 0.01));
  // 变调靠 playbackRate 实现：+5 个半音 ≈ 1.3348 倍速，且和"换采样"是两回事
  check('+5 半音的播放速率 ≈ 1.3348',
    approx(playbackRateForFret(5), Math.pow(2, 5 / 12), 1e-9));
  check('变调不改变取哪个采样（原音名仍然是 E2）',
    (() => {
      const s = Object.create(GuitarSampler.prototype);
      s.manifest = { openStrings: [{ index: 5, note: 'E4', hz: 329.63 }] };
      return s.noteForString(5) === 'E4' && s.stringNotes(5)[0] === 'A4';
    })());
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
