/**
 * 和弦定义：把"六根弦各按几品"变成真实的和弦。
 *
 * 为什么要有这个文件：
 * 在这之前，整把琴永远只有六个**空弦音**（E2 A2 D3 G3 B3 E4），
 * 所以"按一个和弦"实际只响一根弦 —— 听起来当然单调。
 * audio.js 里其实早就有 strum()（齐奏）和 playbackRateForFret()（按品变音高），
 * 缺的只是"和弦 → 一组 (弦, 品)"的指型表，也就是这个文件。
 *
 * 约定：
 *   - 数组顺序固定是 **6弦→1弦**（0 = 最粗的 E2，5 = 最细的 E4），
 *     和 audio.js / landmarks.js 里的 stringIndex 一致；
 *   - `-1` 表示这根弦不弹（闷掉）；
 *   - 品数就是真实吉他的品位，0 = 空弦。加变调（transpose）相当于夹变调夹。
 *
 * 每个和弦都声明了 root + quality，tools/test_chords.mjs 会**用调弦算出实际音高**，
 * 再验证音程结构真的是那个和弦（大三/小三/七度…）。
 * 这样和弦对不对是机器证明的，不靠我听。
 */

/** 标准调弦，6弦→1弦 */
export const TUNING = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
export const MUTE = -1;

const NOTE_PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const PC_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteToMidi(name) {
  const m = /^([A-G][#b]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  let pc = NOTE_PC[m[1]];
  if (pc === undefined) {
    // 支持降号写法
    const flat = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }[m[1]];
    if (!flat) return null;
    pc = NOTE_PC[flat];
  }
  return pc + (Number(m[2]) + 1) * 12;
}

export function midiToPitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

export function midiName(midi) {
  return PC_NAME[midiToPitchClass(midi)];
}

/** 和弦类型 → 组成音的音级（相对根音的半音数） */
export const QUALITIES = {
  maj: { intervals: [0, 4, 7], label: '大三', third: 4 },
  min: { intervals: [0, 3, 7], label: '小三', third: 3 },
  dom7: { intervals: [0, 4, 7, 10], label: '属七', third: 4 },
  maj7: { intervals: [0, 4, 7, 11], label: '大七', third: 4 },
  min7: { intervals: [0, 3, 7, 10], label: '小七', third: 3 },
  sus4: { intervals: [0, 5, 7], label: '挂四', third: null },
  add9: { intervals: [0, 2, 4, 7], label: '加九', third: 4 },
};

/**
 * 大横按指型族：把两个"空弦模板"整体平移到第 n 品，就得到 12 个调的全部常用和弦。
 *
 * 为什么要生成而不是手写：手写 60 个指型一定会抄错。这里是**机械平移**，
 * 而且 tools/test_chords.mjs 会用调弦把每一个算一遍音程结构，
 * 抄错/生成错都会立刻被抓出来（n=0 就是 E/A 的空弦指型，肉眼也能对上）。
 *
 * e = 6 弦根音型（E 型），a = 5 弦根音型（A 型）
 */
const BARRE_FAMILIES = {
  maj: { e: (n) => [n, n + 2, n + 2, n + 1, n, n], a: (n) => [MUTE, n, n + 2, n + 2, n + 2, n] },
  min: { e: (n) => [n, n + 2, n + 2, n, n, n], a: (n) => [MUTE, n, n + 2, n + 2, n + 1, n] },
  dom7: { e: (n) => [n, n + 2, n, n + 1, n, n], a: (n) => [MUTE, n, n + 2, n, n + 2, n] },
  min7: { e: (n) => [n, n + 2, n + 2, n, n + 3, n], a: (n) => [MUTE, n, n + 2, n, n + 1, n] },
  maj7: { e: (n) => [n, n + 2, n + 1, n + 1, n, n], a: (n) => [MUTE, n, n + 2, n + 1, n + 2, n] },
};
/** 6 弦空弦 = E(4)，5 弦空弦 = A(9)：横按第 n 品的根音音级 */
const BARRE_ROOT_PC = { e: 4, a: 9 };

function maxFretOf(frets) {
  return Math.max(...frets.filter((f) => f >= 0));
}

/** `${根音音级}:${类型}` → 该调最好按的一个大横按指型（挑把位最低的） */
const BARRE_TABLE = (() => {
  const table = {};
  for (const [quality, fam] of Object.entries(BARRE_FAMILIES)) {
    for (const which of ['e', 'a']) {
      for (let n = 0; n <= 11; n++) {
        const frets = fam[which](n);
        if (Math.max(...frets) > 12) continue; // 超过 12 品不现实
        const pc = (BARRE_ROOT_PC[which] + n) % 12;
        const key = `${pc}:${quality}`;
        const cur = table[key];
        if (!cur || maxFretOf(frets) < cur.max) {
          table[key] = { frets, max: maxFretOf(frets), shape: `${which === 'e' ? 'E' : 'A'} 型 ${n} 品` };
        }
      }
    }
  }
  return table;
})();

/** 某个调某个类型，表里有没有现成的指型 */
export function hasShapeFor(rootPc, quality) {
  if (BARRE_TABLE[`${rootPc}:${quality}`]) return true;
  return Object.values(CHORDS).some((s) => s.quality === quality && NOTE_PC[s.root] === rootPc);
}

/**
 * **夹变调夹之后该按哪个指型。**
 *
 * 这是这次修坑的核心：`整体变调` 的含义是「夹变调夹」——
 * 你想听到 C 和弦，夹 5 品时应该改按 G 指型（G 上移 5 品 = C），
 * **而不是把和弦本身变成 F**。之前写成了"把和弦名整体移调"，
 * 于是和弦库写着 C Am F G Em Dm、按钮上却显示 F Dm A# C Am Gm，对不上。
 *
 * @param {string|object} shapeOrName 想听到的和弦（和谱子一致的写法）
 * @param {number} transpose 变调（= 夹几品）
 * @returns {object|null} 要按的指型；带上 sounding（实际听起来的名字）和 capo
 */
export function shapeForSounding(shapeOrName, transpose = 0) {
  const want = resolve(shapeOrName);
  if (!want) return null;
  const capo = Math.round(transpose || 0);
  const t = ((capo % 12) + 12) % 12;
  if (t === 0) return want; // 不夹变调夹，直接按它自己
  const needPc = (((NOTE_PC[want.root] - t) % 12) + 12) % 12;

  // 1) 优先用手写的指型（空弦和弦最好按也最好听）。
  //    要排除转位（G/B、C/G 的根音也是 G、C），否则会挑到转位上去
  const candidates = Object.entries(CHORDS)
    .filter(([, s]) => s.quality === want.quality && NOTE_PC[s.root] === needPc)
    .map(([n, s]) => ({ n, s, max: maxFretOf(s.frets), inversion: !!s.bass }))
    .sort((a, b) => a.inversion - b.inversion || a.max - b.max);
  if (candidates.length) {
    const { n, s, max } = candidates[0];
    return { name: n, ...s, sounding: want.name, capo, shapeName: n, shapeMax: max };
  }

  // 2) 没有手写的就用大横按族生成
  const g = BARRE_TABLE[`${needPc}:${want.quality}`];
  if (g) {
    return {
      name: PC_NAME[needPc],
      root: PC_NAME[needPc],
      quality: want.quality,
      frets: g.frets,
      sounding: want.name,
      capo,
      shapeName: PC_NAME[needPc],
      shapeMax: g.max,
      generated: g.shape,
    };
  }
  return null; // 这种类型在这个调没有指型（调用方要如实说明，不能偷偷换个和弦）
}

/**
 * 常用和弦指型。frets 一律 [6弦, 5弦, 4弦, 3弦, 2弦, 1弦]。
 * 全部是标准调弦下的真实按法（0 品 = 空弦），不是编出来的。
 * 12 个调里没列出来的调，由上面的大横按族自动补（shapeForSounding）。
 */
export const CHORDS = {
  // ---- C 调最常用的几个（情歌基本都在这一组里） ----
  C: { root: 'C', quality: 'maj', frets: [MUTE, 3, 2, 0, 1, 0], group: 'C 调常用' },
  Dm: { root: 'D', quality: 'min', frets: [MUTE, MUTE, 0, 2, 3, 1], group: 'C 调常用' },
  Em: { root: 'E', quality: 'min', frets: [0, 2, 2, 0, 0, 0], group: 'C 调常用' },
  F: { root: 'F', quality: 'maj', frets: [1, 3, 3, 2, 1, 1], group: 'C 调常用', note: '大横按，手疼的话优先用 Fmaj7' },
  G: { root: 'G', quality: 'maj', frets: [3, 2, 0, 0, 0, 3], group: 'C 调常用' },
  Am: { root: 'A', quality: 'min', frets: [MUTE, 0, 2, 2, 1, 0], group: 'C 调常用' },
  G7: { root: 'G', quality: 'dom7', frets: [3, 2, 0, 0, 0, 1], group: 'C 调常用' },

  // ---- 色彩和弦（情歌里到处是这些，比三和弦好听很多） ----
  Cmaj7: { root: 'C', quality: 'maj7', frets: [MUTE, 3, 2, 0, 0, 0], group: '色彩' },
  Cadd9: { root: 'C', quality: 'add9', frets: [MUTE, 3, 2, 0, 3, 0], group: '色彩' },
  Dm7: { root: 'D', quality: 'min7', frets: [MUTE, MUTE, 0, 2, 1, 1], group: '色彩' },
  Em7: { root: 'E', quality: 'min7', frets: [0, 2, 2, 0, 3, 0], group: '色彩' },
  Fmaj7: { root: 'F', quality: 'maj7', frets: [MUTE, MUTE, 3, 2, 1, 0], group: '色彩', note: '最简单好按的 F 系' },
  Am7: { root: 'A', quality: 'min7', frets: [MUTE, 0, 2, 0, 1, 0], group: '色彩' },
  Gsus4: { root: 'G', quality: 'sus4', frets: [3, 3, 0, 0, 1, 3], group: '色彩' },
  'G/B': { root: 'G', quality: 'maj', frets: [MUTE, 2, 0, 0, 0, 3], group: '色彩', bass: 'B', note: 'G 转位，用来连接 Am' },
  'C/G': { root: 'C', quality: 'maj', frets: [3, 3, 2, 0, 1, 0], group: '色彩', bass: 'G' },

  // ---- 别的调常用（换调、或者歌里借和弦时用） ----
  D: { root: 'D', quality: 'maj', frets: [MUTE, MUTE, 0, 2, 3, 2], group: '其他调' },
  Dmaj7: { root: 'D', quality: 'maj7', frets: [MUTE, MUTE, 0, 2, 2, 2], group: '其他调' },
  E: { root: 'E', quality: 'maj', frets: [0, 2, 2, 1, 0, 0], group: '其他调' },
  E7: { root: 'E', quality: 'dom7', frets: [0, 2, 0, 1, 0, 0], group: '其他调' },
  A: { root: 'A', quality: 'maj', frets: [MUTE, 0, 2, 2, 2, 0], group: '其他调' },
  Amaj7: { root: 'A', quality: 'maj7', frets: [MUTE, 0, 2, 1, 2, 0], group: '其他调' },
  Bm: { root: 'B', quality: 'min', frets: [MUTE, 2, 4, 4, 3, 2], group: '其他调' },
  Bm7: { root: 'B', quality: 'min7', frets: [MUTE, 2, 0, 2, 0, 2], group: '其他调' },
  B7: { root: 'B', quality: 'dom7', frets: [MUTE, 2, 1, 2, 0, 2], group: '其他调' },
  'F#m': { root: 'F#', quality: 'min', frets: [2, 4, 4, 2, 2, 2], group: '其他调' },
};

/**
 * 手势/按键的 6 个槽位（和六弦板一样，槽 0 = 🤘，槽 5 = 1 指）。
 * 默认这组就是情歌里最常出现的六个和弦。
 */
export const CHORD_BANKS = {
  c_major: { label: 'C 调常用（C G Am Em F G7）', slots: ['C', 'G', 'Am', 'Em', 'F', 'G7'] },
  c_major7: { label: '七和弦（Cmaj7 G Am7 Em7 Fmaj7 Dm7）', slots: ['Cmaj7', 'G', 'Am7', 'Em7', 'Fmaj7', 'Dm7'] },
  ballad: { label: '抒情走向（C Am F G Em Dm）', slots: ['C', 'Am', 'F', 'G', 'Em', 'Dm'] },
  minor: { label: '小调（Am F C G Dm E7）', slots: ['Am', 'F', 'C', 'G', 'Dm', 'E7'] },
};

export const DEFAULT_BANK = 'c_major';

/** 这个和弦实际要弹哪几根弦：[{string, fret}, ...]（已去掉闷掉的） */
export function chordStrings(shapeOrName) {
  const shape = resolve(shapeOrName);
  if (!shape) return [];
  return shape.frets
    .map((fret, string) => ({ string, fret }))
    .filter((s) => s.fret >= 0);
}

/** 组成音（音名，从低到高，保留真实八度顺序） */
export function chordNoteNames(shapeOrName) {
  const shape = resolve(shapeOrName);
  if (!shape) return [];
  return chordMidis(shape)
    .map((midi) => midiName(midi))
    .join(' ')
    .split(' ');
}

/** MIDI 音高（从低到高），用于验证音程结构 */
export function chordMidis(shapeOrName) {
  const shape = resolve(shapeOrName);
  if (!shape) return [];
  return chordStrings(shape)
    .map(({ string, fret }) => noteToMidi(TUNING[string]) + fret)
    .sort((a, b) => a - b);
}

/** 实际发音的音级集合（相对根音的半音数，去重升序） */
export function chordIntervals(shapeOrName) {
  const shape = resolve(shapeOrName);
  if (!shape) return [];
  const rootPc = NOTE_PC[shape.root];
  const set = new Set();
  for (const midi of chordMidis(shape)) set.add((((midi - rootPc) % 12) + 12) % 12);
  return [...set].sort((a, b) => a - b);
}

/**
 * 变调（变调夹）之后，这个和弦实际听起来是什么名字。
 * 只支持升号写法，和 audio.js 的 transposeNote 保持一致。
 */
export function chordSoundingName(shapeOrName, transpose = 0) {
  const shape = resolve(shapeOrName);
  if (!shape) return '';
  // 不升调时直接用它自己的名字（CHORDS 的键里本来就带了 m7 / maj7 后缀）
  if (!transpose) return shape.name;
  const qualitySuffix = {
    maj: '',
    min: 'm',
    dom7: '7',
    maj7: 'maj7',
    min7: 'm7',
    sus4: 'sus4',
    add9: 'add9',
  }[shape.quality];
  const rootMidi = noteToMidi(shape.root + '3') + transpose;
  return midiName(rootMidi) + qualitySuffix;
}

/** 名字 → 带 name 的完整指型对象 */
export function resolve(shapeOrName) {
  if (!shapeOrName) return null;
  if (typeof shapeOrName === 'object') {
    return shapeOrName.frets ? { name: '?', ...shapeOrName } : null;
  }
  const shape = CHORDS[shapeOrName];
  return shape ? { name: shapeOrName, ...shape } : null;
}

/**
 * 一个槽位数组 → 可显示的槽信息。
 *
 * **槽位里存的是"要听到的和弦"（= 谱子上的写法），shape 才是"要按的指型"。**
 * 夹变调夹时这两者不一样：想听 C、夹 5 品 → 按 G 指型。
 * 所以 `slot.name` 永远和弦库标签一致，显示不会对不上。
 *
 * @returns {Array<{slot:number, name:string, shape:object|null, shapeName:string, capo:number, toneless:boolean}>}
 */
export function bankSlots(bankKey, transpose = 0) {
  const bank = CHORD_BANKS[bankKey] || CHORD_BANKS[DEFAULT_BANK];
  return bank.slots.map((name, i) => {
    const shape = shapeForSounding(name, transpose);
    return {
      slot: i,
      name, // 要听到的和弦（跟和弦库标签一致）
      shape, // 要按的指型（可能因为变调夹换掉）
      shapeName: shape ? shape.shapeName || shape.name : name,
      capo: shape ? shape.capo || 0 : Math.round(transpose || 0),
      // 变调夹下这个类型没有指型 → 如实标出来，绝不偷偷换个和弦
      toneless: !shape,
    };
  });
}

/** 诊断用：指型本身是否合法（品位范围、有没有一根弦都不弹） */
export function shapeIssues(shapeOrName) {
  const shape = resolve(shapeOrName);
  const issues = [];
  if (!shape) return ['无法解析'];
  if (!Array.isArray(shape.frets) || shape.frets.length !== 6) {
    issues.push('frets 必须是 6 个');
    return issues;
  }
  const played = shape.frets.filter((f) => f >= 0);
  if (!played.length) issues.push('一根弦都没弹');
  for (const f of shape.frets) {
    if (!Number.isInteger(f) || f < -1 || f > 12) issues.push(`品位 ${f} 不合法`);
  }
  const max = Math.max(...played);
  if (max > 5) issues.push(`最高 ${max} 品，跨度太大不好按`);
  if (!QUALITIES[shape.quality]) issues.push(`未知和弦类型 ${shape.quality}`);
  if (NOTE_PC[shape.root] === undefined) issues.push(`未知根音 ${shape.root}`);
  return issues;
}
