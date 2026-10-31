/**
 * 逻辑层单测（不需要浏览器/摄像头）：
 *   node tools/test_landmarks.mjs
 *
 * 造出"手指伸直/握起"的合成关键点，验证伸展度、手指数、弦号映射、裁剪框都算对。
 */

import {
  angleDeg,
  computeExtension,
  countExtended,
  stringFromFingerCount,
  stringFromGesture,
  classifyShape,
  classifyByTemplates,
  STRING_CN,
  createHandTracker,
  updateHandTracker,
  snapshotHandTracker,
  openDelta,
  opennessOf,
  checkStrumTrigger,
  consumeStrum,
  createMotionTracker,
  updateMotionTracker,
  shouldMute,
  pickDefaultCamera,
  tagForCamera,
  gestureName,
  bboxFromLandmarks,
  toPixels,
  UNKNOWN_STRING,
  FINGER_ORDER,
  FINGERS,
} from '../web/js/landmarks.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function approx(a, b, eps = 0.05) {
  return Math.abs(a - b) <= eps;
}

const DEG = Math.PI / 180;

/** 造一只合成手：straight[name] 为 true 表示该手指伸直 */
function makeHand(straight) {
  const pts = new Array(21);
  pts[0] = { x: 0, y: 0 }; // 腕

  // 每根手指的基准方向（角度制，屏幕坐标 y 向下）
  const base = { thumb: -150, index: -105, middle: -88, ring: -72, pinky: -55 };
  const mcpR = { thumb: 55, index: 80, middle: 84, ring: 78, pinky: 70 };
  const seg = { thumb: 26, index: 34, middle: 36, ring: 33, pinky: 28 };

  for (const name of FINGER_ORDER) {
    const [a, b, c, d] = FINGERS[name];
    const th = base[name] * DEG;
    const r = mcpR[name];
    const s = seg[name];
    const p0 = { x: Math.cos(th) * r, y: Math.sin(th) * r };
    pts[a] = p0;
    if (straight[name]) {
      // 一路沿着同方向伸出去 -> 关节夹角 180°
      const dir = { x: Math.cos(th), y: Math.sin(th) };
      pts[b] = { x: p0.x + dir.x * s, y: p0.y + dir.y * s };
      pts[c] = { x: pts[b].x + dir.x * s, y: pts[b].y + dir.y * s };
      pts[d] = { x: pts[c].x + dir.x * s, y: pts[c].y + dir.y * s };
    } else {
      // 折回来 -> 关节夹角约 90°，判为握起
      const t1 = th + 90 * DEG;
      const t2 = th + 180 * DEG;
      pts[b] = { x: p0.x + Math.cos(th) * s, y: p0.y + Math.sin(th) * s };
      pts[c] = { x: pts[b].x + Math.cos(t1) * s, y: pts[b].y + Math.sin(t1) * s };
      pts[d] = { x: pts[c].x + Math.cos(t2) * s, y: pts[c].y + Math.sin(t2) * s };
    }
  }
  return pts;
}

console.log('\n[1] 角度计算');
{
  const a = { x: 0, y: 0 };
  const b = { x: 1, y: 0 };
  check('直角 = 90°', approx(angleDeg({ x: 1, y: 0 }, a, { x: 0, y: 1 }), 90, 0.001));
  check('共线 = 180°', approx(angleDeg({ x: -1, y: 0 }, a, { x: 1, y: 0 }), 180, 0.001));
  check('零向量不炸', Number.isFinite(angleDeg(a, a, b)));
}

console.log('\n[2] 伸展度：全握');
{
  const feat = computeExtension(makeHand({ thumb: false, index: false, middle: false, ring: false, pinky: false }));
  check('伸指数 = 0', feat.count === 0, `实际 ${feat.count} ext=${JSON.stringify(feat.ext.map((v) => +v.toFixed(2)))}`);
  check('每根手指伸展度 < 0.2', feat.ext.every((v) => v < 0.2), JSON.stringify(feat.ext.map((v) => +v.toFixed(2))));
  check('编码 = 00000', feat.signature === '00000', feat.signature);
}

console.log('\n[3] 伸展度：全伸');
{
  const feat = computeExtension(makeHand({ thumb: true, index: true, middle: true, ring: true, pinky: true }));
  check('伸指数 = 5', feat.count === 5, `实际 ${feat.count} ext=${JSON.stringify(feat.ext.map((v) => +v.toFixed(2)))}`);
  check('每根手指伸展度 > 0.8', feat.ext.every((v) => v > 0.8), JSON.stringify(feat.ext.map((v) => +v.toFixed(2))));
  check('编码 = 11111', feat.signature === '11111', feat.signature);
}

console.log('\n[4] 伸展度：只伸食指');
{
  const feat = computeExtension(makeHand({ thumb: false, index: true, middle: false, ring: false, pinky: false }));
  check('伸指数 = 1', feat.count === 1, `实际 ${feat.count}`);
  check('编码 = 01000', feat.signature === '01000', feat.signature);
  check('食指伸展度 > 0.8 且中指 < 0.2', feat.ext[1] > 0.8 && feat.ext[2] < 0.2);
}

console.log('\n[5] 三个手指的各组合（应覆盖 0~5）');
{
  const combos = [
    [false, false, false, false, false, 0],
    [false, true, false, false, false, 1],
    [false, true, true, false, false, 2],
    [false, true, true, true, false, 3],
    [false, true, true, true, true, 4],
    [true, true, true, true, true, 5],
  ];
  for (const [t, i, m, r, p, expect] of combos) {
    const keys = { thumb: t, index: i, middle: m, ring: r, pinky: p };
    const feat = computeExtension(makeHand(keys));
    check(`伸指数 = ${expect}`, feat.count === expect, `实际 ${feat.count} (${feat.signature})`);
  }
  check('countExtended 阈值生效', countExtended([0.9, 0.6, 0.5, 0.1, 0.0]) === 2);
}

console.log('\n[6] 手指数 → 弦号映射');
{
  // 约定：伸 1 根 = 1 弦，… 伸 5 根 = 5 弦；6 弦用 🤘；握拳 = 没选弦
  // 内部索引 0 = 6 弦（最粗），5 = 1 弦（最细）
  const idx = [0, 1, 2, 3, 4, 5].map((n) => stringFromFingerCount(n));
  check(
    '0指=未选弦, 1指=1弦(5), 2指=2弦(4), 3指=3弦(3), 4指=4弦(2), 5指=5弦(1)',
    JSON.stringify(idx) === JSON.stringify([UNKNOWN_STRING, 5, 4, 3, 2, 1]),
    JSON.stringify(idx),
  );
  check(
    '越界钳位（9 根按 5 根算 → 5弦；负数按 0 根算 → 未选弦）',
    stringFromFingerCount(9) === 1 && stringFromFingerCount(-3) === UNKNOWN_STRING,
    `${stringFromFingerCount(9)} / ${stringFromFingerCount(-3)}`,
  );
}

console.log('\n[7] 手势 → 弦号（含 🤘）');
{
  // 顺序 (拇指, 食指, 中指, 无名指, 小指)
  const cases = [
    [[1, 0, 0, 0, 1], 0, 'horns'], // 🤘 → 6 弦
    [[0, 1, 0, 0, 0], 5, '1finger'], // 食指 → 1 弦
    [[0, 1, 1, 0, 0], 4, '2finger'], // 食指+中指 → 2 弦
    [[0, 1, 1, 1, 0], 3, '3finger'], // 三根 → 3 弦
    [[0, 1, 1, 1, 1], 2, '4finger'], // 四根 → 4 弦
    [[1, 1, 1, 1, 1], 1, '5finger'], // 五指张开 → 5 弦
    [[0, 0, 0, 0, 0], UNKNOWN_STRING, 'fist'], // 握拳 → 没选弦
  ];
  for (const [up, want, wantGesture] of cases) {
    const got = stringFromGesture(up);
    check(
      `${wantGesture} → 弦索引 ${want}`,
      got.string === want && got.gesture === wantGesture,
      `实际 ${got.string} / ${got.gesture}`,
    );
  }

  // 关键冲突点：🤘 是"伸出 2 根"，绝不能按 2 根手指判成 2 弦
  check('🤘 优先于根数判定', stringFromGesture([0.9, 0.1, 0.1, 0.1, 0.9]).string === 0);
  check('拇指+小指但食指也伸 → 不算 🤘（按 3 根=3弦）', stringFromGesture([0.9, 0.9, 0.1, 0.1, 0.9]).string === 3);
  // 用真实伸展度（不是 0/1 布尔）也要能过
  check('实数伸展度可用', stringFromGesture([0.95, 0.12, 0.08, 0.2, 0.88]).gesture === 'horns');
  check('阈值附近按阈值判', stringFromGesture([0.6, 0, 0, 0, 0.6]).string === 0 && stringFromGesture([0.5, 0, 0, 0, 0.5]).string === UNKNOWN_STRING);
}

console.log('\n[8] handpose_x 裁剪框');
{
  const pts = [{ x: 100, y: 50 }, { x: 200, y: 150 }];
  const bb = bboxFromLandmarks(pts, { pad: 1.1 });
  check('是正方形', approx(bb.size, bb.x2 - bb.x1, 1e-6) && approx(bb.size, bb.y2 - bb.y1, 1e-6));
  check('边长 = 100 * 1.1', approx(bb.size, 110, 1e-6), String(bb.size));
  check('中心不变', approx((bb.x1 + bb.x2) / 2, 150, 1e-6) && approx((bb.y1 + bb.y2) / 2, 100, 1e-6));
}

console.log('\n[9] 归一化坐标 → 像素 + 镜像');
{
  const norm = [{ x: 0.25, y: 0.5, z: 0 }, { x: 0.75, y: 0.25, z: 0.1 }];
  const px = toPixels(norm, 640, 480, false);
  check('非镜像 x', approx(px[0].x, 160) && approx(px[1].x, 480));
  check('y 换算', approx(px[0].y, 240) && approx(px[1].y, 120));
  const mir = toPixels(norm, 640, 480, true);
  check('镜像 x 取反', approx(mir[0].x, 480) && approx(mir[1].x, 160));
}

console.log('\n[10] 判定状态机：滞回 / 投票 / 锁定（这是"不灵敏、乱串弦"的治本层）');
{
  // 连着喂同样的伸展度，直到 EMA 收敛
  const feed = (t, ext, times, t0 = 0, step = 33) => {
    let s = null;
    for (let i = 0; i < times; i++) s = updateHandTracker(t, ext, t0 + i * step);
    return s;
  };
  const FIST = [0.06, 0.05, 0.05, 0.05, 0.05];
  const ONE = [0.05, 0.92, 0.06, 0.06, 0.06]; // 食指 → 1 弦
  const TWO = [0.05, 0.92, 0.9, 0.06, 0.06]; // 食指+中指 → 2 弦
  const FIVE = [0.92, 0.92, 0.92, 0.9, 0.9]; // 五指 → 5 弦

  // --- 滞回：0.45 落在 off(0.4) 与 on(0.55) 之间，不该改变已有状态
  const t1 = createHandTracker();
  feed(t1, FIST, 20);
  check('握拳 → 没选弦', t1.string === UNKNOWN_STRING, String(t1.string));
  const mid = [0.05, 0.45, 0.45, 0.05, 0.05];
  feed(t1, mid, 20);
  check('一直处在阈值之间 → 仍判握拳（不误触发）', t1.string === UNKNOWN_STRING, String(t1.string));
  feed(t1, TWO, 12);
  check('明确伸出 → 2 弦', t1.string === 4, String(t1.string));
  feed(t1, mid, 12);
  check('退回阈值之间 → 保持 2 弦（滞回生效，不闪断）', t1.string === 4, String(t1.string));
  feed(t1, FIST, 12);
  check('明确握拳 → 回到没选弦', t1.string === UNKNOWN_STRING, String(t1.string));

  // --- 投票：单帧抖动不能改弦
  const t2 = createHandTracker();
  feed(t2, TWO, 20);
  check('稳定 2 弦', t2.string === 4 && t2.confidence > 0.8, `${t2.string} conf=${t2.confidence}`);
  updateHandTracker(t2, FIVE, 1000); // 一帧抽风
  check('单帧串到 5 指 → 弦号不变', t2.string === 4, String(t2.string));
  updateHandTracker(t2, FIVE, 1033);
  check('两帧仍然不够票 → 弦号不变', t2.string === 4, String(t2.string));
  feed(t2, FIVE, 20, 1100);
  check('真的换成五指张开 → 变成 5 弦', t2.string === 1, String(t2.string));

  // --- 锁定保持：久无稳定结论才放手
  const t3 = createHandTracker({ holdMs: 500 });
  feed(t3, ONE, 20);
  check('稳定 1 弦', t3.string === 5, String(t3.string));
  // 三种手势轮流来，谁也凑不够票（这才是真正的"判不出来"）
  const rotate = [ONE, TWO, FIVE];
  let now3 = 1000;
  for (let i = 0; i < 3; i++) {
    updateHandTracker(t3, rotate[i % 3], now3);
    now3 += 33;
  }
  check('短暂判不出来 → 仍保持 1 弦', t3.string === 5, String(t3.string));
  for (let i = 0; i < 40; i++) {
    updateHandTracker(t3, rotate[i % 3], now3);
    now3 += 33;
  }
  check('长时间判不出来 → 放开，没选弦', t3.string === UNKNOWN_STRING, String(t3.string));

  // --- 张合度历史：给"张开即拨弦"用
  // 注意 EMA 有 2~3 帧延迟，所以"张开"要看几帧的累积，这也正是它稳的原因
  const t4 = createHandTracker();
  let now4 = 0;
  for (let i = 0; i < 15; i++) {
    updateHandTracker(t4, FIST, now4);
    now4 += 33;
  }
  const before = openDelta(t4, now4);
  for (let i = 0; i < 4; i++) {
    updateHandTracker(t4, FIVE, now4);
    now4 += 33;
  }
  check('握拳时张合增量 ≈ 0', before < 0.05, String(before));
  check('张开后张合增量 ≥ 0.6', openDelta(t4, now4) >= 0.6, String(openDelta(t4, now4)));
  check('张开程度到 1', opennessOf(t4) === 1, String(opennessOf(t4)));
  // 单帧不足以过阈值（平滑的代价），确认这个边界是已知的
  const t5 = createHandTracker();
  for (let i = 0; i < 15; i++) updateHandTracker(t5, FIST, i * 33);
  const oneFrame = updateHandTracker(t5, FIVE, 600);
  check('单帧不会立刻判成张开（EMA 延迟，属预期）', oneFrame.count < 5, String(oneFrame.count));
}

console.log('\n[10b] 拨弦触发：上升沿 + 重新武装（治"举着手连发"）');
{
  const FIST = [0.05, 0.05, 0.05, 0.05, 0.05];
  const FIVE = [0.9, 0.92, 0.9, 0.9, 0.88];
  const TWO = [0.05, 0.92, 0.9, 0.06, 0.06];
  const t = createHandTracker();
  let now = 0;
  const tick = (ext) => {
    now += 16.7;
    updateHandTracker(t, ext, now);
    return checkStrumTrigger(t, now);
  };
  for (let i = 0; i < 15; i++) tick(FIST);
  let fired = 0;
  // 张开来并一直举着 120 帧
  for (let i = 0; i < 120; i++) {
    const r = tick(FIVE);
    if (r.hit) {
      fired += 1;
      consumeStrum(t);
    }
  }
  check('张开并一直举着 → 只触发 1 次', fired === 1, `触发 ${fired} 次`);

  // 收回来 → 再张开 → 应该能再触发
  for (let i = 0; i < 12; i++) tick(FIST);
  let fired2 = 0;
  for (let i = 0; i < 20; i++) {
    const r = tick(FIVE);
    if (r.hit) {
      fired2 += 1;
      consumeStrum(t);
    }
  }
  check('收回后再张开 → 又能触发 1 次', fired2 === 1, `触发 ${fired2} 次`);

  // 平台期不应该有上升沿
  check('平台期增量为 0', Math.abs(openDelta(t, now, 150)) < 1e-9, String(openDelta(t, now, 150)));

  // 半开（2 指）也应能触发：张开度从 0 涨到 0.4 = 达到 need 0.35
  const t2 = createHandTracker();
  let now2 = 0;
  const tick2 = (ext) => {
    now2 += 16.7;
    updateHandTracker(t2, ext, now2);
    return checkStrumTrigger(t2, now2);
  };
  for (let i = 0; i < 15; i++) tick2(FIST);
  let fired3 = 0;
  for (let i = 0; i < 30; i++) {
    const r = tick2(TWO);
    if (r.hit) {
      fired3 += 1;
      consumeStrum(t2);
    }
  }
  check('只张开 2 根手指也能触发', fired3 >= 1, `触发 ${fired3} 次`);
  check('只张开 2 根手指不会连发', fired3 === 1, `触发 ${fired3} 次`);
}

console.log('\n[10c] 静态图片：单帧直接采信（不走投票）');
{
  const t = createHandTracker();
  const snap = updateHandTracker(t, [0.9, 0.92, 0.9, 0.9, 0.88], 0, { instant: true });
  check('单帧 instant → 立刻得到 5 弦', snap.string === 1, String(snap.string));
  check('单帧 instant 理由可读', /按单帧判定/.test(snap.reason), snap.reason);
  // 同样的单帧如果走投票，是出不来结果的
  const t2 = createHandTracker();
  const snap2 = updateHandTracker(t2, [0.9, 0.92, 0.9, 0.9, 0.88], 0);
  check('单帧不走 instant → 还没结论（需要 3 帧投票）', snap2.string === UNKNOWN_STRING, String(snap2.string));
}

console.log('\n[11] 备选映射方案 long（只数四根长指，最能压住拇指串弦）');
{
  const cases = [
    [[0, 1, 0, 0, 0], 5, '1long'],
    [[1, 0, 0, 0, 0], UNKNOWN_STRING, 'thumbOnly'], // 只伸拇指 → 明确不选弦
    [[1, 1, 0, 0, 0], 5, '1long'], // 拇指+食指 = 1 弦（拇指不参与计数）
    [[1, 1, 1, 0, 0], 4, '2long'], // 拇指+食指+中指 = 2 弦
    [[0, 1, 1, 0, 0], 4, '2long'],
    [[0, 1, 1, 1, 0], 3, '3long'],
    [[0, 1, 1, 1, 1], 2, 'fourLong'], // 四根长指，拇指收起 → 4 弦
    [[1, 1, 1, 1, 1], 1, 'open5'], // 五指全开 → 5 弦
    [[1, 0, 0, 0, 1], 0, 'horns'], // 🤘 → 6 弦
  ];
  for (const [up, want, wantKind] of cases) {
    const got = classifyShape(up.map(Boolean), { mapping: 'long' });
    check(
      `long: [${up.join('')}] → ${want === UNKNOWN_STRING ? '没选弦' : want}`,
      got.string === want && got.kind === wantKind,
      `实际 ${got.string}/${got.kind}`,
    );
  }
  // 同样的姿势，两种方案对比：拇指甩动时不影响 long 的结果
  const withThumb = [1, 1, 1, 0, 0];
  const noThumb = [0, 1, 1, 0, 0];
  check(
    'long 映射下拇指抖动不改变弦号',
    classifyShape(withThumb.map(Boolean), { mapping: 'long' }).string ===
      classifyShape(noThumb.map(Boolean), { mapping: 'long' }).string,
  );
  check(
    'count 映射下拇指抖动会改变弦号（这就是要修的问题）',
    classifyShape(withThumb.map(Boolean), { mapping: 'count' }).string !==
      classifyShape(noThumb.map(Boolean), { mapping: 'count' }).string,
  );
  check('gesture 名兼容', gestureName('horns') === 'horns' && gestureName('2long') === '2finger' && gestureName('fist') === 'fist');
}

console.log('\n[13] 实测三个症状的回归（用户手机/笔记本摄像头上的真实表现）');
{
  // 症状 1：比划 🤘 有时响 1 弦 —— 因为拇指漏判时 🤘 只剩小指，被数成"1 根"
  const hornsThumbDropped = [0, 0, 0, 0, 1];
  const g1 = classifyShape(hornsThumbDropped.map(Boolean), { mapping: 'count' });
  check('🤘 但拇指没判出来（只有小指）→ 仍然是 6 弦', g1.string === 0, `实际 ${STRING_CN[g1.string] ?? '没选弦'}/${g1.kind}`);
  const g1b = classifyShape(hornsThumbDropped.map(Boolean), { mapping: 'long' });
  check('long 映射下同样 → 6 弦', g1b.string === 0, `实际 ${g1b.kind}`);
  // 完整 🤘 当然还是 6 弦
  check('完整 🤘（拇指+小指）→ 6 弦', classifyShape([1, 0, 0, 0, 1].map(Boolean), { mapping: 'count' }).string === 0);

  // 症状 2：比划 1（食指）不响 —— 只伸拇指时旧版判"没选弦"，形成死区
  const thumbOnly = [1, 0, 0, 0, 0];
  const g2 = classifyShape(thumbOnly.map(Boolean), { mapping: 'count' });
  check('count 映射：只判出拇指 → 也算"伸 1 根" = 1 弦（不再是死区）', g2.string === 5, `实际 ${g2.kind}`);
  check('long 映射：只判出拇指 → 没选弦（拇指不参与计数）', classifyShape(thumbOnly.map(Boolean), { mapping: 'long' }).string === UNKNOWN_STRING);

  // 症状 3：食指指点时拇指被一起判成伸出 → count 映射会变 2 弦
  const indexWithThumb = [1, 1, 0, 0, 0];
  check('count：拇指+食指 → 2 弦（这就是"比划 1 变成 2"的原因）',
    classifyShape(indexWithThumb.map(Boolean), { mapping: 'count' }).string === 4);
  check('long：拇指+食指 → 1 弦（拇指不计数，症状消失）',
    classifyShape(indexWithThumb.map(Boolean), { mapping: 'long' }).string === 5);
  check('两手势都不再落到"没选弦"', g1.string !== UNKNOWN_STRING && g2.string !== UNKNOWN_STRING);
}

console.log('\n[14] 用户校准模板：最近邻判定（吸收个人手型差异）');
{
  // 假设这是用户的手：拇指天然偏高（0.6 左右），所以固定阈值 0.55 必然出问题
  const userTemplates = {
    5: [0.62, 0.93, 0.12, 0.1, 0.08], // 1 弦：只伸食指（拇指也翘着）
    4: [0.6, 0.9, 0.88, 0.1, 0.1], // 2 弦
    3: [0.58, 0.9, 0.87, 0.85, 0.1], // 3 弦
    2: [0.65, 0.9, 0.88, 0.86, 0.84], // 4 弦（拇指翘着）
    1: [0.95, 0.94, 0.92, 0.9, 0.9], // 5 弦：五指全开
    0: [0.68, 0.12, 0.1, 0.1, 0.92], // 6 弦：🤘
  };
  const near = (ext, want, label) => {
    const got = classifyByTemplates(ext, userTemplates);
    check(label, got.string === want, `判成 ${got.string === UNKNOWN_STRING ? '没选弦' : STRING_CN[got.string]}（距离 ${got.distance}）`);
  };
  // 固定阈值下 [1,1,0,0,0] 会判成 2 弦；有模板就能正确判成 1 弦
  near([0.62, 0.93, 0.12, 0.1, 0.08], 5, '模板：拇指翘着的"1 指" → 1 弦');
  near([0.6, 0.92, 0.9, 0.12, 0.11], 4, '模板：抖动的"2 指" → 2 弦');
  near([0.68, 0.15, 0.08, 0.12, 0.9], 0, '模板：拇指不稳的 🤘 → 6 弦');
  near([0.66, 0.1, 0.12, 0.09, 0.95], 0, '模板：🤘 但拇指很低 → 仍是 6 弦');
  near([0.9, 0.95, 0.93, 0.9, 0.88], 1, '模板：五指全开 → 5 弦');
  // 握拳：离所有模板都远 → 不选弦
  const fist = classifyByTemplates([0.2, 0.05, 0.05, 0.05, 0.05], userTemplates, { maxDist: 0.7 });
  check('模板：握拳 → 离模板都太远 → 没选弦', fist.string === UNKNOWN_STRING && fist.kind === 'templateFar',
    `实际 ${fist.kind}/${fist.distance}`);
  // 模板与内置规则的对比：同一个"拇指翘着的 1 指"，内置规则在 count 下会错
  const ext1 = [0.62, 0.93, 0.12, 0.1, 0.08];
  const up1 = ext1.map((v) => v >= 0.55);
  check('同一姿势内置 count 规则会判错（2 弦）', classifyShape(up1, { mapping: 'count' }).string === 4);
  check('同一姿势内置 long 规则也有机会对（1 弦）', classifyShape(up1, { mapping: 'long' }).string === 5);
  check('模板判定给出距离信息（可用于界面上解释）', typeof near === 'function' && fist.distance > 0.7);
  // 模板本身的自检：两个模板不能太近，否则说明校准姿势没区分开
  const check1 = classifyByTemplates(userTemplates[5], userTemplates);
  check('模板自检：拿模板去问自己，距离应为 0', check1.distance === 0 && check1.string === 5, String(check1.distance));
}

console.log('\n[14.5] 校准模板的两道闸：手指数和判定弦号必须永远同源');
{
  // 这个症状是用户实测报的："手指数显示正确，但对应全错"（1→3、2→6、5→3、🤘→1）。
  // 病根：模板最近邻和手指数是两条独立的路，模板又几乎每帧都能命中，
  // 于是屏幕上"伸出 1 根"（对的）和"判定 3 弦"（模板给的）可以同时成立。
  // 这一组就是那个症状的反向测试。
  const feed = (t, ext, times, t0 = 0, step = 33) => {
    let s = null;
    for (let i = 0; i < times; i++) s = updateHandTracker(t, ext, t0 + i * step);
    return s;
  };

  // ① 两道闸：距离太远 或 和第二像的打平 → 不采信模板
  const degenerate = {
    // 六个模板几乎一模一样（用户校准姿势没做开）→ 谁都比谁近不了多少
    5: [0.5, 0.9, 0.5, 0.5, 0.5],
    4: [0.5, 0.9, 0.52, 0.5, 0.5],
    3: [0.5, 0.9, 0.5, 0.52, 0.5],
    2: [0.5, 0.9, 0.5, 0.5, 0.52],
    1: [0.5, 0.9, 0.51, 0.5, 0.5],
    0: [0.5, 0.9, 0.5, 0.51, 0.5],
  };
  const tBad = createHandTracker({ templates: degenerate });
  const snapBad = feed(tBad, [0.05, 0.92, 0.9, 0.06, 0.06], 20); // 干净的"2 指"
  check('退化模板（6 个几乎一样）不再冒充"命中"：退回内置规则',
    snapBad.judgedBy === 'rule', `judgedBy=${snapBad.judgedBy}`);
  check('退化模板下，2 指仍然正确判成 2 弦', snapBad.string === 4, STRING_CN[snapBad.string] ?? '没选弦');
  check('模板"有机会但没把握"会被标出来（提示用户重新校准）', snapBad.templateRejected === true);

  // ② 同源不变式：判定弦号 ↔ 判定手指数，任何时候都是一一对应
  const clean = { 5: [0.05, 0.92, 0.06, 0.06, 0.06], 0: [0.05, 0.06, 0.06, 0.06, 0.92] };
  const cases = [
    [0.05, 0.92, 0.06, 0.06, 0.06],
    [0.05, 0.92, 0.9, 0.06, 0.06],
    [0.05, 0.92, 0.9, 0.9, 0.06],
    [0.05, 0.92, 0.9, 0.9, 0.9],
    [0.9, 0.92, 0.9, 0.9, 0.9],
    [0.05, 0.06, 0.06, 0.06, 0.92],
  ];
  let bad = [];
  for (const ext of cases) {
    const t = createHandTracker({ templates: clean });
    const s = feed(t, ext, 20);
    if (s.string === UNKNOWN_STRING) continue;
    const want = s.string === 0 ? 6 : 6 - s.string; // 🤘 = 第 6 个
    if (s.countAsJudged !== want) bad.push(`${STRING_CN[s.string]}→${s.countAsJudged}根(应${want})`);
  }
  check('判定弦号与判定手指数永远一一对应（🤘=第6、其余=6-弦号）', bad.length === 0, bad.join(' '));

  // ③ 模板和手指数打架时必须能被测出来（这就是界面要弹警告的那个布尔量）
  const conflict = { 3: [0.05, 0.92, 0.06, 0.06, 0.06] }; // 明明只有食指，却标成"3 弦"
  const tC = createHandTracker({ templates: conflict });
  const sC = feed(tC, [0.05, 0.92, 0.06, 0.06, 0.06], 20);
  check('模板和手指数打架时 judgedAgrees=false（界面据此弹"清除校准"）',
    sC.judgedAgrees === false, `agrees=${sC.judgedAgrees}`);
  check('打架时给出了两边各自的结论，便于界面解释清楚',
    sC.ruleString === 5 && sC.string === 3,
    `规则=${STRING_CN[sC.ruleString]} 模板=${STRING_CN[sC.string]}`);
  check('打架时"判定手指数"跟着判定弦号走（不再自相矛盾）', sC.countAsJudged === 3, String(sC.countAsJudged));

  // ④ 默认 maxDist 必须收紧（0.7 在 5 维里等于"谁都像"，是这次乱套的直接原因）
  //    用手册里的默认值跑一个"什么都不像"的姿势，必须落到规则而不是模板
  const tFar = createHandTracker({ templates: clean });
  const sFar = feed(tFar, [0.6, 0.6, 0.6, 0.6, 0.6], 20);
  check('离模板都远 → 不采信模板', sFar.judgedBy === 'rule' || sFar.string === UNKNOWN_STRING,
    `judgedBy=${sFar.judgedBy} 距离=${sFar.distance}`);
}

console.log('\n[15] 闷音判定：伸 1 根手指不算握拳（1 弦不发声的真凶）');
{
  // 真凶场景：左手 1 根手指选 1 弦，右手张开要拨弦
  // 旧版 count<=1 会把左手当握拳 → 每帧 mute → 主音量压到 0 → 拨了但没声
  const bug = [
    { key: 'Left', count: 1 },
    { key: 'Right', count: 5 },
  ];
  check('左手 1 根手指选弦 + 右手张开 → 不闷音（1 弦能出声）', shouldMute(bug, 'Left') === false);
  check('旧写法 count<=1 会误判成闷音（这就是那个 bug）',
    bug.some((c) => c.count <= 1) === true);
  // 其余弦本来就没问题（手指数 >= 2）
  for (const n of [2, 3, 4, 5]) {
    check(`${n} 根手指选弦时也不会误闷音`,
      shouldMute([{ key: 'Left', count: n }, { key: 'Right', count: 5 }], 'Left') === false);
  }
  // 🤘 是"2 根"，同样不受影响
  check('🤘（伸出 2 根）选 6 弦时不误闷音',
    shouldMute([{ key: 'Left', count: 2 }, { key: 'Right', count: 5 }], 'Left') === false);
  // 该闷的时候还是要闷：拨弦的那只手握起来
  check('拨弦手握起 → 闷音', shouldMute([{ key: 'Left', count: 2 }, { key: 'Right', count: 0 }], 'Left') === true);
  check('两只手都握起 → 闷音', shouldMute([{ key: 'Left', count: 0 }, { key: 'Right', count: 0 }], null) === true);
  check('没看到手 → 不闷音', shouldMute([], 'Left') === false);
  // 只有一只手（单手弹）：1 根手指不该被闷掉
  check('单手弹：只有一只手且伸 1 根 → 不闷音', shouldMute([{ key: 'Left', count: 1 }], 'Left') === false);
  check('单手弹：只有一只手且握拳 → 闷音', shouldMute([{ key: 'Left', count: 0 }], 'Left') === true);
}

console.log('\n[12] 手腕速度跟踪（挥动触发用）');
{
  const m = createMotionTracker();
  check('首帧速度为 0', updateMotionTracker(m, { x: 0.5, y: 0.5 }, 0.2, 0) === 0);
  const s1 = updateMotionTracker(m, { x: 0.7, y: 0.5 }, 0.2, 100);
  check('横向移动 → 有速度', s1 > 0, String(s1));
  // 0.2 归一化距离 / 0.2 掌长 = 1 掌长，用时 0.1s → 10 掌长/秒
  check('速度量级正确（掌长/秒）', approx(s1, 10, 0.5), String(s1));
  const m2 = createMotionTracker();
  updateMotionTracker(m2, { x: 0.5, y: 0.5 }, 0.2, 0);
  updateMotionTracker(m2, { x: 0.5, y: 0.5 }, 0.2, 100);
  updateMotionTracker(m2, { x: 0.5, y: 0.5 }, 0.2, 200);
  check('静止 → 速度 0', updateMotionTracker(m2, { x: 0.5, y: 0.5 }, 0.2, 200) === 0);
  updateMotionTracker(m2, { x: 0.5, y: 0.5 }, 0.2, 300);
  check(
    '超出 220ms 窗口的老样本被丢掉（t=0 那条没了）',
    !m2.samples.some((s) => s[0] === 0) && m2.samples.every((s) => s[0] >= 80),
    JSON.stringify(m2.samples.map((s) => s[0])),
  );
}

console.log('\n[16] 摄像头默认选择（别把手机虚拟摄像头当成默认）');
{
  // 这台机器上真实存在的两个设备（实测标签）
  const INTEGRATED = { deviceId: 'cam-int', label: 'Integrated Camera (5986:2160)' };
  const OPPO = { deviceId: 'cam-oppo', label: 'OPPO Find X8 (Windows 虚拟摄像头)' };
  const blank = (id) => ({ deviceId: id, label: '' });

  check('有内置镜头 → 必须选内置（哪怕手机镜头排在前面）',
    pickDefaultCamera([OPPO, INTEGRATED], '') === 'cam-int');
  check('用户明确选过手机 → 尊重用户选择',
    pickDefaultCamera([OPPO, INTEGRATED], 'cam-oppo') === 'cam-oppo');
  check('用户选过的设备已经不在了 → 退回内置',
    pickDefaultCamera([OPPO, INTEGRATED], 'cam-gone') === 'cam-int');
  // 未授权时设备名全空：只能瞎猜，但外面绝不能把猜的结果当成"用户选择"存起来
  check('设备名全空时挑第一个（临时结果）', pickDefaultCamera([blank('a'), blank('b')], '') === 'a');
  check('只有手机/虚拟摄像头时也得挑一个（能用就行）', pickDefaultCamera([OPPO], '') === 'cam-oppo');
  check('没有摄像头 → 空串', pickDefaultCamera([], '') === '');
  check('内置镜头的标签判定', tagForCamera(INTEGRATED.label) === '💻 内置');
  check('手机虚拟摄像头的标签判定', tagForCamera(OPPO.label) === '📱 手机/虚拟');
  check('认不出的当普通摄像头', tagForCamera('USB2.0 HD UVC WebCam') === '🎥 摄像头');
  check('HD User Facing（很多笔记本这么叫）→ 内置',
    pickDefaultCamera([OPPO, { deviceId: 'x', label: 'HD User Facing' }], '') === 'x');
  check('DroidCam 这类手机镜头 → 不优先',
    pickDefaultCamera([{ deviceId: 'd', label: 'DroidCam Source 3' }, INTEGRATED], '') === 'cam-int');
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
