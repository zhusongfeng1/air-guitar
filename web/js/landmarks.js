/**
 * 手部关键点纯逻辑层：不碰 DOM、不碰摄像头，可以在 Node 里直接单测。
 *
 * 关键点编号遵循 MediaPipe / handpose_x 的通用 21 点约定：
 *   0 腕
 *   1-4   拇指 CMC/MCP/IP/TIP
 *   5-8   食指 MCP/PIP/DIP/TIP
 *   9-12  中指
 *   13-16 无名指
 *   17-20 小指
 */

export const WRIST = 0;

export const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const FINGER_CN = {
  thumb: '拇指',
  index: '食指',
  middle: '中指',
  ring: '无名指',
  pinky: '小指',
};

/** 骨架连线（画面用） */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** 弦的显示名。索引 0 = 最粗的 6 弦，5 = 最细的 1 弦。 */
export const STRING_LABELS = ['6弦 E', '5弦 A', '4弦 D', '3弦 G', '2弦 B', '1弦 e'];

/** 🤘 手势：拇指 + 小指伸出、其余三根握起 —— 用来单独表示 6 弦 */
export const HORNS = [1, 0, 0, 0, 1];

export const UNKNOWN_STRING = -1;

// 关节夹角映射到伸展度的区间（度）：越接近 180° 越直
const BEND_LOW = 95;
const BEND_HIGH = 178;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 指尖到手腕的距离 / 掌长。伸直的手指离手腕远，蜷起的手指靠近手心。 */
const REACH_RANGE = {
  // [完全蜷起, 完全伸直] 的经验区间
  thumb: [0.85, 1.45],
  finger: [1.05, 1.95],
};

/** 把归一化坐标（0~1）转成像素坐标；mirror 用于自拍镜面显示 */
export function toPixels(landmarks, width, height, mirror = false) {
  return landmarks.map((p) => ({
    x: (mirror ? 1 - p.x : p.x) * width,
    y: p.y * height,
    z: (p.z || 0) * width,
  }));
}

/** 向量 ba 与 bc 的夹角（度），b 为顶点 */
export function angleDeg(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-8 || n2 < 1e-8) return 180;
  let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

function stretch(angle) {
  const v = (angle - BEND_LOW) / (BEND_HIGH - BEND_LOW);
  return Math.max(0, Math.min(1, v));
}

/**
 * 算 5 根手指的伸展度（0 = 完全握起，1 = 完全伸直）。
 * pts 需要是同一空间下的 2D/3D 坐标（像素即可）。
 *
 * 两个线索加权融合（这是"稳"的关键）：
 *   1. 关节夹角 —— 手指直不直；
 *   2. 指尖到手腕的距离 / 掌长 —— 手指有没有真的伸出去。
 * 光看夹角时，手指"弯但没握起来"会误判成伸出；加上距离线索就能压住。
 */
export function computeExtension(pts, { useReach = true, reachWeight = 0.35 } = {}) {
  const palmSpan = Math.hypot(pts[WRIST].x - pts[9].x, pts[WRIST].y - pts[9].y) || 1;
  const ext = [];

  for (const name of FINGER_ORDER) {
    const [a, b, c, d] = FINGERS[name];
    let angleScore;
    if (name === 'thumb') {
      // 拇指用 CMC 张开角与 MCP 弯曲角里较小的那个，更稳
      const aCmc = angleDeg(pts[WRIST], pts[a], pts[d]);
      const aMcp = angleDeg(pts[a], pts[b], pts[d]);
      angleScore = Math.min(stretch(aCmc), stretch(aMcp));
    } else {
      const aPip = angleDeg(pts[a], pts[b], pts[d]);
      const aDip = angleDeg(pts[b], pts[c], pts[d]);
      angleScore = Math.min(stretch(aPip), stretch(aDip));
    }

    if (!useReach) {
      ext.push(angleScore);
      continue;
    }
    const [lo, hi] = name === 'thumb' ? REACH_RANGE.thumb : REACH_RANGE.finger;
    const reach = Math.hypot(pts[d].x - pts[WRIST].x, pts[d].y - pts[WRIST].y) / palmSpan;
    const reachScore = clamp01((reach - lo) / (hi - lo));
    ext.push(clamp01((1 - reachWeight) * angleScore + reachWeight * reachScore));
  }

  const pinch =
    Math.hypot(
      pts[FINGERS.thumb[3]].x - pts[FINGERS.index[3]].x,
      pts[FINGERS.thumb[3]].y - pts[FINGERS.index[3]].y,
    ) / palmSpan;

  return {
    ext,
    palmSpan,
    pinch,
    count: countExtended(ext),
    signature: ext.map((v) => (v >= 0.55 ? '1' : '0')).join(''),
    perFinger: FINGER_ORDER.reduce((acc, n, i) => ((acc[n] = ext[i]), acc), {}),
  };
}

/** 伸展的手指个数 */
export function countExtended(ext, thresh = 0.55) {
  return ext.reduce((n, v) => n + (v >= thresh ? 1 : 0), 0);
}

/**
 * 手指数 → 弦号（返回 0~5 的内部索引，0 = 6 弦最粗；-1 = 没选弦）。
 *
 * 约定（和用户对齐过）：
 *   伸 1 根 = 1 弦，伸 2 根 = 2 弦，… 伸 5 根 = 5 弦
 *   6 弦不用"根数"表示，而是用 🤘（拇指+小指）这个专门手势
 *   握拳(0 根) = 没选弦
 */
export function stringFromFingerCount(n) {
  const k = Math.max(0, Math.min(5, n | 0));
  if (k === 0) return UNKNOWN_STRING;
  return 6 - k;
}

/**
 * 伸直度向量 → 弦号。🤘 优先判定，否则按伸出根数。
 * @param {number[]} ext 5 维伸展度，顺序 (拇指,食指,中指,无名指,小指)
 * @param {{thresh?:number, mapping?:'count'|'long'}} opts
 * @returns {{string:number, gesture:string, fingersUp:boolean[]}}
 */
export function stringFromGesture(ext, { thresh = 0.55, mapping = 'count' } = {}) {
  const up = ext.map((v) => v >= thresh);
  const cls = classifyShape(up, { mapping });
  return { ...cls, gesture: gestureName(cls.kind), fingersUp: up };
}

/** kind → 好读的手势名（界面和日志用） */
export function gestureName(kind) {
  if (kind === 'horns' || kind === 'pinkyOnly') return 'horns';
  if (kind === 'fist' || kind === 'thumbOnly') return 'fist';
  if (kind === 'template' || kind === 'templateFar') return 'template';
  const m = /^(\d)(count|long)$/.exec(kind);
  if (m) return `${m[1]}finger`;
  if (kind === 'open5') return '5finger';
  if (kind === 'fourLong') return '4finger';
  return kind;
}

/**
 * 伸出模式 → 弦号。两种映射方案：
 *
 *  'count'（用户原本的设计）：拇指也算一根，伸 N 根手指 = N 弦，
 *          🤘 = 6 弦。好处是直觉；代价是拇指不稳时 1/2 弦和 4/5 弦会串。
 *  'long'（更稳）：只数食指/中指/无名指/小指这四根长的，
 *          1~4 根 = 1~4 弦，五指全开 = 5 弦，🤘 = 6 弦。
 *          拇指只影响 4 弦/5 弦这一处，其余完全不受拇指干扰。
 *
 * @param {boolean[]} up 5 维布尔数组，顺序 (拇指,食指,中指,无名指,小指)
 * @returns {{string:number, kind:string, fingersUp:boolean[]}}
 */
export function classifyShape(up, { mapping = 'count' } = {}) {
  const [T, I, M, R, P] = up;
  const longUp = (I ? 1 : 0) + (M ? 1 : 0) + (R ? 1 : 0) + (P ? 1 : 0);

  // 🤘 的判据**不看拇指**：小指伸 + 中间三根握起就是 6 弦（拇指伸不伸都算）。
  //
  // 实测踩过的坑：要求"拇指也必须在"时，拇指一旦漏判，就只剩小指 = 数成 1 根，
  // 于是 🤘 会被判成 1 弦。拇指是五根里最难判稳的，所以把它从判据里去掉；
  // "只伸小指"这个姿势没有别的合理解释（没人用小指表示 1 弦）。
  if (P && !I && !M && !R) {
    return { string: 0, kind: T ? 'horns' : 'pinkyOnly', fingersUp: up };
  }

  const total = longUp + (T ? 1 : 0);

  if (mapping === 'long') {
    if (longUp === 0) return { string: UNKNOWN_STRING, kind: T ? 'thumbOnly' : 'fist', fingersUp: up };
    if (longUp === 4) return { string: T ? 1 : 2, kind: T ? 'open5' : 'fourLong', fingersUp: up };
    return { string: 6 - longUp, kind: `${longUp}long`, fingersUp: up };
  }

  if (total === 0) return { string: UNKNOWN_STRING, kind: 'fist', fingersUp: up };
  // 只伸拇指 = 伸了 1 根 → 1 弦。
  // 旧版这里判"没选弦"，造成死区：食指指点时稍微低调一点、只剩拇指过阈值，
  // 比划"1"就完全不发声（实测症状）。按"伸 N 根 = N 弦"的字面意思，它就该是 1 弦。
  return { string: stringFromFingerCount(Math.min(5, total)), kind: `${total}count`, fingersUp: up };
}

/** 弦的中文名，索引 0 = 6 弦 */
export const STRING_CN = ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'];

/**
 * 用**用户自己校准出来的模板**做最近邻分类。
 *
 * 固定的布尔规则永远会在边界上失手（每个人的手型、拇指习惯、镜头距离都不一样）。
 * 让用户把 6 个手势各比划一次、把当时的伸展度向量存下来，之后按"最像哪个模板"来判，
 * 就能自动吸收掉"他的拇指天然偏高"这类个人差异。
 *
 * @param {number[]} ext 当前伸展度
 * @param {Object|Array} templates { [弦索引]: 伸展度向量 } 或按索引排列的数组
 * @param {{maxDist?:number}} opts maxDist 之外认为"都不像"
 * @returns {null|{string:number, kind:string, distance:number, secondDistance:number|null, nearest:number}}
 */
export function classifyByTemplates(ext, templates, { maxDist = 0.7 } = {}) {
  const entries = (
    Array.isArray(templates)
      ? templates.map((t, i) => [i, t])
      : Object.entries(templates || {})
  ).filter(([, t]) => Array.isArray(t) && t.length === ext.length);
  if (!entries.length) return null;

  let best = null;
  let second = null;
  for (const [k, t] of entries) {
    const d = Math.sqrt(ext.reduce((a, v, i) => a + (v - t[i]) ** 2, 0));
    const idx = Number(k);
    if (!best || d < best.d) {
      second = best;
      best = { string: idx, d };
    } else if (!second || d < second.d) {
      second = { string: idx, d };
    }
  }
  const near = best.d <= maxDist;
  return {
    string: near ? best.string : UNKNOWN_STRING,
    kind: near ? 'template' : 'templateFar',
    nearest: best.string,
    distance: Number(best.d.toFixed(3)),
    secondDistance: second ? Number(second.d.toFixed(3)) : null,
    margin: second ? Number((second.d - best.d).toFixed(3)) : null,
    fingersUp: ext.map((v) => v >= 0.55),
  };
}

// --------------------------------------------------------------------------
// 每只手的判定状态机
//
// 单帧结果直接拿来用是这套东西不灵敏的根因。这里叠了四层：
//   1. EMA 平滑        —— 不让一帧抖动直接改变结果
//   2. 逐指滞回        —— 进入"伸出"要 >= on，退出要 < off（中间区间保持原状）
//   3. 时间投票        —— 最近 N 帧里至少 M 帧同意才算数
//   4. 结果锁定        —— 投票没过时保持上一次的弦，绝不闪断
// --------------------------------------------------------------------------

export const DEFAULT_TRACKER = {
  alpha: 0.55, // EMA 平滑系数，越大越跟手
  on: 0.55, // 判定"伸出"的阈值
  off: 0.4, // 判定"收回"的阈值（滞回下限）
  voteWindow: 5, // 参与投票的帧数
  voteNeed: 3, // 至少多少帧同意
  holdMs: 1200, // 结果不稳定时，最多保持上一次的弦多久
  mapping: 'count',
  templates: null, // 用户校准的模板 { [弦索引]: 伸展度向量 }，有就优先用
  templateMaxDist: 0.45, // 离模板超过这个距离就认为"都不像"（原来 0.7 太松，等于随机命中）
  templateMinMargin: 0.08, // 比第二像的模板至少要近这么多，否则认为是"打平"，不采信
};

export function createHandTracker(opts = {}) {
  return {
    cfg: { ...DEFAULT_TRACKER, ...opts },
    ext: null, // 平滑后的伸展度
    up: [false, false, false, false, false],
    votes: [], // 最近若干帧的分类结果（内部索引，-1 = 没选弦）
    string: UNKNOWN_STRING, // 当前锁定的弦
    prevString: UNKNOWN_STRING, // 上一次锁定的弦（单手弹时用"张开前那根弦"）
    lockedAt: 0,
    openHistory: [], // [[t, openness]]，用来判断"张开的瞬间"
    armed: true, // 拨弦是否处于"可触发"状态（触发后要等手收回一点才重新武装）
    armedAtOpenness: 0,
    rawCount: 0,
    count: 0,
    kind: 'init',
    confidence: 0,
    margin: 0,
    changed: false,
    reason: '等待第一帧',
  };
}

/** 当前张开程度（0~1）= 伸出根数 / 5 */
export function opennessOf(t) {
  return t.up.reduce((n, b) => n + (b ? 1 : 0), 0) / 5;
}

/**
 * 用一帧的原始伸展度更新状态机。
 * @param {object} t createHandTracker() 的返回值
 * @param {number[]} rawExt 原始 5 维伸展度
 * @param {number} nowMs 单调时间（毫秒）
 * @param {{instant?:boolean}} opts instant=true 用于静态图片：没有时间轴，直接采信当前帧
 */
export function updateHandTracker(t, rawExt, nowMs, { instant = false } = {}) {
  const c = t.cfg;

  // 1) EMA 平滑
  t.ext = t.ext ? t.ext.map((v, i) => v + c.alpha * (rawExt[i] - v)) : [...rawExt];

  // 2) 逐指滞回
  t.up = t.ext.map((v, i) => (t.up[i] ? v > c.off : v >= c.on));
  t.rawCount = t.ext.reduce((n, v) => n + (v >= c.on ? 1 : 0), 0);
  t.count = t.up.reduce((n, b) => n + (b ? 1 : 0), 0);

  // 3) 分类 + 时间投票
  //    有用户校准的模板就优先用模板（最近邻），否则退回内置布尔规则。
  //
  //    ⚠ 这里踩过一个极难查的坑，值得写下来：
  //    模板一旦"最近邻"命中就无条件生效，而**手指数是另一条路算出来的**
  //    （滞回后的 t.up）。两者互相独立，于是屏幕上"伸出 1 根"（对的）和
  //    "判定 3 弦"（模板给的）可以同时成立 —— 用户看到的就是
  //    "手指数显示正确，但和弦/弦号全不对应"。
  //    更糟的是 maxDist 原来是 0.7：在 5 维单位区间里，五根手指平均差 0.31
  //    就算"像"，几乎每帧都能命中某个模板，判定等于随机挑一个。
  //
  //    现在三道闸，保证"看到的"和"用的"永远同源：
  //      ① 模板必须**明显**比第二像的模板更像（margin），打平就不采信；
  //      ② 采信模板时，判定结果**连手指数一起给**（countAsJudged / judgedAgrees），
  //         界面必须把"判定依据"和"看到的根数"是不是一致说出来，不许悄悄改口径；
  //      ③ 记录规则判定结果 ruleString，用来算"模板和手指数是否打架"。
  const byTemplate = c.templates ? classifyByTemplates(t.ext, c.templates, { maxDist: c.templateMaxDist }) : null;
  const tMargin = byTemplate ? byTemplate.margin : null;
  const templateOk =
    !!byTemplate &&
    byTemplate.string !== UNKNOWN_STRING &&
    (tMargin === null || tMargin >= (c.templateMinMargin || 0));
  const ruleCls = classifyShape(t.up, { mapping: c.mapping });
  const cls = templateOk ? byTemplate : ruleCls;
  t.judgedBy = templateOk ? 'template' : byTemplate ? 'rule' : 'rule';
  // 模板"有机会但没把握"时单独标出来，方便用户知道该重新校准
  t.templateRejected = !!byTemplate && !templateOk;
  t.templateMargin = tMargin;
  t.ruleString = ruleCls.string;
  // 判定结果换算成"手指数"：弦号 0 = 🤘（对应"第 6 个"），其余 = 6 - 弦号
  t.countAsJudged =
    cls.string === UNKNOWN_STRING ? t.count : cls.string === 0 ? 6 : 6 - cls.string;
  // 判定依据和"手指数直接推出来的弦号"是否一致。不一致就是用户看到的那个症状，
  // 界面必须显式警告（并且给"清除校准"的出路），绝不能装作没事。
  t.judgedAgrees = cls.string === ruleCls.string;
  t.kind = cls.kind;
  t.distance = cls.distance ?? null;
  t.nearest = cls.nearest ?? null;
  t.votes.push(cls.string);
  while (t.votes.length > c.voteWindow) t.votes.shift();

  const tally = new Map();
  for (const v of t.votes) tally.set(v, (tally.get(v) || 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [topString, topVotes] = ranked[0] || [UNKNOWN_STRING, 0];
  const second = ranked[1] ? ranked[1][1] : 0;
  t.confidence = t.votes.length ? topVotes / t.votes.length : 0;
  t.margin = (topVotes - second) / Math.max(1, t.votes.length);

  const enoughVotes = t.votes.length >= c.voteNeed && topVotes >= c.voteNeed;
  t.changed = false;
  if (instant) {
    // 静态图片：只有这一帧，投票机制不适用，直接采信当前帧
    t.string = cls.string;
    t.lockedAt = nowMs;
    t.confidence = 1;
    t.reason = `按单帧判定：${cls.string === UNKNOWN_STRING ? '没选弦' : STRING_LABELS[cls.string]}`;
    t.changed = true;
  } else if (enoughVotes && topString !== t.string) {
    t.prevString = t.string;
    t.string = topString;
    t.lockedAt = nowMs;
    t.changed = true;
    t.reason = `识别到 ${topString === UNKNOWN_STRING ? '没选弦' : STRING_LABELS[topString]}`;
  } else if (enoughVotes) {
    t.lockedAt = nowMs;
    t.reason =
    topString === UNKNOWN_STRING
      ? t.kind === 'templateFar'
        ? `离校准模板都太远（最近 ${t.nearest === null ? '-' : STRING_LABELS[t.nearest]} ${t.distance}）`
        : '握拳/没选弦'
      : `${STRING_LABELS[topString]}（置信 ${(t.confidence * 100) | 0}%）`;
  } else if (t.string !== UNKNOWN_STRING && nowMs - t.lockedAt > c.holdMs) {
    // 太久没有稳定结论，放弃锁定
    t.string = UNKNOWN_STRING;
    t.changed = true;
    t.reason = '结果不稳定，已放弃';
  } else {
    t.reason = `结果不稳定（${t.votes.length} 帧里最强 ${topVotes} 票），先保持`;
  }

  // 4) 张开程度历史（给"张开即拨弦"用）
  t.openHistory.push([nowMs, opennessOf(t)]);
  while (t.openHistory.length && nowMs - t.openHistory[0][0] > 600) t.openHistory.shift();

  return snapshotHandTracker(t);
}

/** 最近 windowMs 内张开程度涨了多少（用来识别"张开"这个动作） */
export function openDelta(t, nowMs, windowMs = 280) {
  if (!t.openHistory.length) return 0;
  let min = Infinity;
  for (const [ts, v] of t.openHistory) {
    if (nowMs - ts <= windowMs && v < min) min = v;
  }
  if (!Number.isFinite(min)) min = t.openHistory[0][1];
  return opennessOf(t) - min;
}

/**
 * 拨弦触发判定（含上升沿 + 重新武装）。
 *
 * 只看"窗口内涨了多少"是不够的：手一直张着时，窗口里只要还留着张开前的低值，
 * 冷却一过就会再触发一次，于是举着手会连发。所以：
 *   - 用较短的窗口（默认 150ms）抓真正的"上升沿"，平台期自然归零；
 *   - 触发后把 armed 置 false，必须等手收回一点（张合度比触发时低 0.25 以上，
 *     或者低于 0.35）才重新武装 → 一次张开只响一次。
 *
 * @returns {{hit:boolean, delta:number, armed:boolean}}
 */
export function checkStrumTrigger(t, nowMs, { windowMs = 150, need = 0.35, release = 0.25 } = {}) {
  const open = opennessOf(t);
  if (!t.armed && (open <= t.armedAtOpenness - release || open < 0.35)) {
    t.armed = true;
  }
  const delta = openDelta(t, nowMs, windowMs);
  return { hit: t.armed && delta >= need, delta, armed: t.armed };
}

/** 记下"这一次拨弦已经用掉了"，等手收回再武装 */
export function consumeStrum(t) {
  t.armed = false;
  t.armedAtOpenness = opennessOf(t);
}

export function snapshotHandTracker(t) {
  return {
    ext: t.ext ? t.ext.map((v) => Number(v.toFixed(3))) : null,
    up: [...t.up],
    count: t.count,
    rawCount: t.rawCount,
    string: t.string,
    stringName: t.string === UNKNOWN_STRING ? null : STRING_LABELS[t.string],
    kind: t.kind,
    distance: t.distance ?? null,
    nearest: t.nearest ?? null,
    // 判定依据：'template' = 用你校准的模板，'rule' = 用内置规则
    judgedBy: t.judgedBy || 'rule',
    templateRejected: !!t.templateRejected, // 有模板但没把握，退回规则
    templateMargin: t.templateMargin ?? null,
    ruleString: t.ruleString ?? null,
    countAsJudged: t.countAsJudged ?? t.count,
    judgedAgrees: t.judgedAgrees !== false,
    armed: t.armed,
    confidence: Number(t.confidence.toFixed(2)),
    margin: Number(t.margin.toFixed(2)),
    changed: t.changed,
    openness: Number(opennessOf(t).toFixed(2)),
    reason: t.reason,
  };
}

// --------------------------------------------------------------------------
// 摄像头选择（纯逻辑，放在这里是为了能单测）
// --------------------------------------------------------------------------

/** 疑似手机 / 虚拟摄像头 */
export const CAM_PHONE_HINT =
  /(phone|手机|droidcam|iriun|camo|epoccam|ivcam|virtual|虚拟|obs|ndi|dummy|screen)/i;
/** 疑似笔记本内置（有就优先选中） */
export const CAM_BUILTIN_HINT =
  /(integrated|internal|built-?in|内置|hd webcam|front|user facing|前置|笔记本|notebook|laptop|facetime)/i;

export function tagForCamera(label) {
  if (CAM_PHONE_HINT.test(label)) return '📱 手机/虚拟';
  if (CAM_BUILTIN_HINT.test(label)) return '💻 内置';
  return '🎥 摄像头';
}

/**
 * 默认选哪个摄像头：**用户明确选过的** → 内置镜头 → 非手机/虚拟的第一个 → 第一个。
 *
 * 踩过的坑：savedId 只能是用户在下拉框里亲手选过的。
 * 早期版本把"自动挑的结果"也存了进去，于是没授权时（设备名全空）瞎猜到的手机虚拟摄像头
 * 被固化成"用户选择"，之后哪怕能看见"内置摄像头"这个名字也永远轮不到它。
 */
export function pickDefaultCamera(cams, savedId) {
  if (!cams || !cams.length) return '';
  if (savedId && cams.some((c) => c.deviceId === savedId)) return savedId;
  const builtin = cams.find((c) => CAM_BUILTIN_HINT.test(c.label || ''));
  if (builtin) return builtin.deviceId;
  const notPhone = cams.find((c) => !CAM_PHONE_HINT.test(c.label || ''));
  if (notPhone) return notPhone.deviceId;
  return cams[0].deviceId || '';
}

// --------------------------------------------------------------------------

/**
 * 是否该闷音（"握起的那只手把弦按住"）。
 *
 * 这里踩过一个很隐蔽的坑：旧版写的是 `count <= 1`，于是**伸出 1 根手指也被当成握拳**。
 * 结果"左手 1 根手指选 1 弦"会一直触发闷音，把主音量压到 0，
 * 右手张开明明拨了弦、面板也显示触发了，却一点声音都没有——只有 1 弦会这样，
 * 因为其余手势的手指数都 ≥ 2。
 *
 * 正确规则：正在选弦的那只手不算握拳（它可能正是"1 根手指"），
 * 只有当别的（要拨弦的）手握起来、或者两只手都握着时，才闷音。
 *
 * @param {{key:string,count:number}[]} counts 每只手的伸指数
 * @param {string|null} stringHandKey 正在选弦的那只手
 */
export function shouldMute(counts, stringHandKey = null) {
  if (!counts || !counts.length) return false;
  const allFist = counts.every((c) => c.count === 0);
  const others = stringHandKey ? counts.filter((c) => c.key !== stringHandKey) : counts;
  return allFist || others.some((c) => c.count === 0);
}

/** 手腕速度跟踪（归一化坐标 / 秒），用来识别"挥动"这个动作 */export function createMotionTracker() {
  return { last: null, samples: [], speed: 0 };
}

export function updateMotionTracker(m, wrist, palmSpan, nowMs, windowMs = 220) {
  m.samples.push([nowMs, wrist.x, wrist.y, palmSpan || 1]);
  while (m.samples.length && nowMs - m.samples[0][0] > windowMs) m.samples.shift();
  if (m.samples.length < 2) return 0;
  const [t0, x0, y0, p0] = m.samples[0];
  const [t1, x1, y1] = m.samples[m.samples.length - 1];
  const dt = Math.max(1, t1 - t0) / 1000;
  const d = Math.hypot(x1 - x0, y1 - y0) / (p0 || 1); // 单位：掌长
  m.speed = d / dt; // 掌长/秒
  return m.speed;
}

/**
 * 由关键点算方形包围框。裁剪比例按 handpose_x 作者 README 的做法：
 *   w = max(|x2-x1|, |y2-y1|) * 1.1，围绕中心取正方形
 * 这个框后续会喂给 handpose_x 做关键点回归。
 */
export function bboxFromLandmarks(pts, { pad = 1.1 } = {}) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  const w = Math.max(x2 - x1, y2 - y1) * pad;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return { x1: cx - w / 2, y1: cy - w / 2, x2: cx + w / 2, y2: cy + w / 2, size: w };
}

/** 手关键点的中文速览，便于日志和测试断言 */
export function describeHand(feat) {
  const names = FINGER_ORDER.filter((n, i) => feat.ext[i] >= 0.55).map((n) => FINGER_CN[n]);
  return {
    count: feat.count,
    upNames: names,
    signature: feat.signature,
    ext: feat.ext.map((v) => Number(v.toFixed(2))),
  };
}
