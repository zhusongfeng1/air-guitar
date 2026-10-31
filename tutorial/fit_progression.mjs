/**
 * 把一首歌的**和弦走向**翻译成"这 6 根空弦上怎么弹"。
 *
 *   node tutorial/fit_progression.mjs "Am F C G" --transpose=5
 *   node tutorial/fit_progression.mjs "Am F C G" --transpose=5 --wav=demo.wav
 *   node tutorial/fit_progression.mjs "Em C G D" --transpose=0 --bpm=76 --wav=demo.wav
 *
 * 为什么需要它：这把琴只有 6 个音（空弦），一首歌的和弦根音必然有几个不在里面。
 * 于是编配就变成一道"选最近的可弹音"的题 —— 这个脚本把那道题算清楚：
 *   优先根音 → 没有就弹五度 → 再没有就弹三度 → 实在没有才用最近的邻音（并报出偏差）。
 * 偏差超过 50 音分就标 ⚠，那种音弹出来是走音的，要换替代音。
 *
 * 输出的是**低音线**（一次一个音），因为这乐器是单音的：一只手选弦、另一只手张开拨弦，
 * 一次只响一根弦。
 */

import { render, writeWav } from './render_demo.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'web', 'assets', 'guitar');
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));

const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function parseNote(name) {
  const m = /^([A-Ga-g])(#|b)?/.exec(name.trim());
  if (!m) return null;
  const base = NOTE_SEMI[m[1].toUpperCase()];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return ((base + acc) % 12 + 12) % 12;
}

/** 解析和弦名：只要根音和"三度是大是小" */
export function parseChord(name) {
  const root = parseNote(name);
  if (root === null) return null;
  const rest = name.trim().slice(1).replace(/^#|^b/, '');
  // dim / ° / ø / m7b5 的三度也是小三度 —— 漏了这条会把 Bdim 的三度算成 D#（不在弦上）
  const diminished = /dim|°|ø|m7b5|min7b5/i.test(rest);
  const minor = /^m(?!aj)/.test(rest) || /min/i.test(rest) || /^m$/.test(rest) || diminished;
  const sus = /sus/i.test(rest);
  return { name: name.trim(), root, minor, sus, diminished };
}

/** 当前变调下 6 根空弦：从 6 弦到 1 弦，带音名/音高/弦号 */
export function openStrings(transpose = 0) {
  return manifest.openStrings
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((o) => {
      const midi = (Number(/(\d+)$/.exec(o.note)[1]) + 1) * 12 + parseNote(o.note) + transpose;
      return {
        string: o.index,
        // index 0 是 6 弦（最粗），不是 1 弦 —— 别标反
        label: `${6 - o.index}弦`,
        note: `${SHARP[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`,
        midi,
        pitchClass: ((midi % 12) + 12) % 12,
      };
    });
}

const cents = (a, b) => 1200 * Math.log2(a / b);

/**
 * 给一个和弦挑一根弦。
 * @returns {{string:number, note:string, role:'根音'|'五度'|'三度'|'邻音', centsOff:number}}
 */
export function pickString(chord, strings, { preferLow = true } = {}) {
  const want = [
    { semi: 0, role: '根音' },
    { semi: 7, role: '五度' },
    { semi: chord.minor ? 3 : 4, role: '三度' },
  ];
  const sorted = strings.slice().sort((a, b) => (preferLow ? a.midi - b.midi : b.midi - a.midi));

  for (const w of want) {
    const target = chord.root + w.semi;
    // 完全同音名的弦（跨八度也算），优先最贴近中音区的
    const exact = strings.filter((s) => ((s.pitchClass % 12) + 12) % 12 === ((target % 12) + 12) % 12);
    if (exact.length) {
      const pick = sorted.find((s) => exact.includes(s)) || exact[0];
      return {
        string: pick.string,
        label: pick.label,
        note: pick.note,
        role: w.role,
        centsOff: 0,
        target: SHARP[target % 12],
      };
    }
  }
  // 都没有：挑最近的邻音，并老实报出偏差（音级距离，跨八度不影响）
  let best = null;
  for (const s of strings) {
    // 到根音的音级距离，取 0..6（6 = 三全音，最远）
    const raw = (((s.pitchClass - chord.root) % 12) + 12) % 12;
    const distance = Math.min(raw, 12 - raw);
    if (!best || distance < best.distance) best = { s, distance };
  }
  return {
    string: best.s.string,
    label: best.s.label,
    note: best.s.note,
    role: '邻音',
    centsOff: best.distance * 100,
    target: SHARP[chord.root % 12],
  };
}

/** 把和弦走向编成一条可弹的低音线（每个和弦 4 拍，第 1 拍根音、第 3 拍一个高一点的音） */
export function arrangement(progression, { transpose = 0, beatsPerChord = 4 } = {}) {
  const strings = openStrings(transpose);
  const chords = progression.map(parseChord).filter(Boolean);
  const events = [];
  const plan = [];
  chords.forEach((chord, i) => {
    const base = pickString(chord, strings, { preferLow: true });
    const high = pickString(chord, strings, { preferLow: false });
    const t0 = i * beatsPerChord;
    events.push({ string: base.string, beat: t0, velocity: 0.8 });
    events.push({ string: base.string, beat: t0 + 1.5, velocity: 0.5 });
    // 第 3 拍补一个别的高音弦，避免整段只有低音
    if (high.string !== base.string) events.push({ string: high.string, beat: t0 + 2, velocity: 0.6 });
    events.push({ string: base.string, beat: t0 + 2.5, velocity: 0.5 });
    if (high.string !== base.string) events.push({ string: high.string, beat: t0 + 3, velocity: 0.6 });
    plan.push({ chord, base, high, beat: t0 });
  });
  return { plan, events, strings };
}

// ---- 命令行 ----
const SEMI_TO_KEY = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? '1';
    else positional.push(a);
  }
  const progressionText = positional.join(' ') || 'Am F C G';
  const transpose = Number(flags.transpose ?? 0);
  const bpm = Number(flags.bpm ?? 72);
  const progression = progressionText.split(/[\s,|]+/).filter(Boolean);

  const { plan, events, strings } = arrangement(progression, { transpose });

  console.log(`\n和弦走向：${progression.join(' → ')}`);
  console.log(`整体变调：${transpose > 0 ? '+' : ''}${transpose} 个半音`);
  console.log(`6 根空弦：${strings.map((s) => `${s.label}=${s.note}`).join('  ')}`);
  const tonic = strings[0].note;
  console.log(`→ 这组弦是 ${tonic.replace(/\d/, '')} 小调的 m11 色彩（可弹的主音：${tonic.replace(/\d/, '')}）`);
  console.log('');
  for (const p of plan) {
    const warn = p.base.centsOff > 50 ? '  ⚠ 偏差大，弹出来会走音' : '';
    console.log(
      `  ${p.chord.name.padEnd(6)} 第 ${String(p.beat / 4 + 1).padStart(2)} 小节 → 弹 ${p.base.note.padEnd(4)} ` +
        `(${p.base.label}, ${p.base.role}${p.base.centsOff ? `，差 ${p.base.centsOff} 音分` : ''})${warn}`,
    );
  }
  const bad = plan.filter((p) => p.base.centsOff > 50).length;
  const ok = plan.length - bad;
  console.log(`\n  ${ok}/${plan.length} 个和弦能找到不离调的空弦音；${bad} 个需要换替代音（或把变调换成别的调）`);

  if (flags.wav) {
    const out = join(HERE, flags.wav); // 只允许写到 tutorial/ 下，避免误写别处
    const r = render(events, { bpm, transpose, leadInBeats: 0.5 });
    writeWav(out, r);
    console.log(`  已渲染试听：tutorial/${flags.wav}（${(r.samples.length / r.sampleRate).toFixed(1)} 秒，${events.length} 个音）`);
  }
  return { plan, events, bad };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
