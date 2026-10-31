/**
 * 和弦指型验证（不靠耳朵，靠音程结构）。
 *
 *   node tools/test_chords.mjs
 *
 * 每个和弦都做这几件事：
 *   1. 指型本身合法（品位范围、弦数、不能一根弦都不弹）；
 *   2. **用标准调弦算出真实音高**，检查有没有"不该出现的音"（错音）；
 *   3. 根音必须在（不然就不是这个和弦）；
 *   4. 决定大小三和弦的那个三度音必须在（不然大三听成小三也发现不了）；
 *   5. 七和弦的七度音必须在；
 *   6. 转位和弦（G/B）的最低音必须是声明的那个低音。
 *
 * 这些是"和弦是不是真的"的充分判据：只要有一条不符合，和弦就是错的。
 */
import {
  CHORDS,
  CHORD_BANKS,
  QUALITIES,
  TUNING,
  MUTE,
  bankSlots,
  chordIntervals,
  chordMidis,
  chordNoteNames,
  chordSoundingName,
  chordStrings,
  midiName,
  noteToMidi,
  resolve,
  shapeIssues,
} from '../web/js/chords.js';

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

console.log('\n=== 和弦指型验证 ===\n');

// ---- 调弦本身 ----
const expectTuning = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
TUNING.forEach((n, i) => ok(`调弦 ${i === 0 ? '6弦' : `${6 - i}弦`} = ${n}`, noteToMidi(n) === expectTuning[i], `算出 ${noteToMidi(n)}`));
ok('TUNING 一共 6 根弦', TUNING.length === 6);
ok('MIDI 转换可逆（E2→40→E2）', midiName(40) === 'E');

// ---- 每个和弦 ----
const names = Object.keys(CHORDS);
console.log(`检查 ${names.length} 个和弦指型...\n`);
for (const name of names) {
  const shape = resolve(name);
  const issues = shapeIssues(name);
  ok(`${name}：指型合法`, issues.length === 0, issues.join('；'));

  const midis = chordMidis(shape);
  const intervals = chordIntervals(shape);
  const spec = QUALITIES[shape.quality];
  const allowed = new Set(spec.intervals);
  const rootPc = noteToMidi(shape.root + '3') % 12;

  // 2. 不能有和弦外的音
  const extra = intervals.filter((i) => !allowed.has(i));
  ok(`${name}：没有和弦外的音`, extra.length === 0, `多了 ${extra.map((i) => `${i}半音(${midiName(rootPc + i)})`).join(',')}`);

  // 3. 根音必须在
  const pcs = new Set(midis.map((m) => m % 12));
  ok(`${name}：含根音 ${shape.root}`, pcs.has(rootPc), `实际 ${midis.map((m) => midiName(m)).join(' ')}`);

  // 4. 三度（sus4 看四度）
  const thirdInterval = spec.third === null ? 5 : spec.third;
  ok(
    `${name}：含${spec.third === null ? '四度' : '三度'}音（决定大小三和弦）`,
    intervals.includes(thirdInterval),
    `实际音级 ${intervals.join(',')}`,
  );

  // 5. 七度
  const seventh = { dom7: 10, maj7: 11, min7: 10 }[shape.quality];
  if (seventh !== undefined) {
    ok(`${name}：含七度音`, intervals.includes(seventh), `实际音级 ${intervals.join(',')}`);
  }

  // 6. 转位低音
  if (shape.bass) {
    ok(`${name}：最低音是 ${shape.bass}`, midiName(midis[0]) === shape.bass, `实际最低音 ${midiName(midis[0])}`);
  }

  // 附加：弦数与音数一致
  const played = chordStrings(shape);
  ok(`${name}：弹 ${played.length} 根弦（有 ${midis.length} 个音）`, played.length === midis.length);
}

// ---- 变调（变调夹）之后的名字 ----
ok('C +2 半音 = D', chordSoundingName('C', 2) === 'D', chordSoundingName('C', 2));
ok('Am +3 半音 = Cm', chordSoundingName('Am', 3) === 'Cm', chordSoundingName('Am', 3));
ok('G7 +5 半音 = C7', chordSoundingName('G7', 5) === 'C7', chordSoundingName('G7', 5));
ok('Cmaj7 +2 = Dmaj7', chordSoundingName('Cmaj7', 2) === 'Dmaj7', chordSoundingName('Cmaj7', 2));
ok('不升调时名字不变', chordSoundingName('Fmaj7', 0) === 'Fmaj7');

// ---- C 调七个级数是不是都在（情歌用得到的那些） ----
const cMajorNeeded = ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7'];
for (const n of cMajorNeeded) ok(`C 调必备和弦 ${n} 存在且合法`, !!CHORDS[n] && shapeIssues(n).length === 0);
// 三和弦的大小三属性要正确（这是最容易写反的地方）
const mustBeMajor = ['C', 'F', 'G', 'D', 'E', 'A'];
const mustBeMinor = ['Dm', 'Em', 'Am', 'Bm', 'F#m'];
for (const n of mustBeMajor) ok(`${n} 是大三和弦`, chordIntervals(n).includes(4) && !chordIntervals(n).includes(3));
for (const n of mustBeMinor) ok(`${n} 是小三和弦`, chordIntervals(n).includes(3) && !chordIntervals(n).includes(4));

// ---- 槽位（手势/按键用的 6 个） ----
for (const [key, bank] of Object.entries(CHORD_BANKS)) {
  const slots = bankSlots(key);
  ok(`和弦库 ${key}：6 个槽`, slots.length === 6);
  slots.forEach((s, i) => {
    ok(`和弦库 ${key} 槽${i}（${s.name}）存在`, !!resolve(s.name), s.name);
  });
}

// ---- 手势/按键槽位 → 和弦（和弦模式靠这个映射，网页自检也依赖它） ----
console.log('\n槽位 → 和弦（和弦模式：伸 2 指 = 槽 4）：\n');
{
  // 识别层算出来的是"弦号"0..5，和弦模式下直接当槽位用。
  // 指 1→槽5，2→槽4，3→槽3，4→槽2，5→槽1，🤘→槽0（= landmarks.js 的 6-n）
  const slotFromFingers = (n) => 6 - n;
  const slots = bankSlots('c_major');
  ok('默认和弦库有 6 个槽', slots.length === 6);
  for (const s of slots) {
    const parts = chordStrings(s.name);
    const pcs = [...new Set(chordNoteNames(s.name))].sort().join(' ');
    const fingers = s.slot === 0 ? '🤘' : `${6 - s.slot} 指`; // 槽 0 是 🤘（不是"伸 6 指"）
    console.log(
      `  槽${s.slot}（${fingers} / 按键 ${s.slot + 1}）→ ${s.name.padEnd(4)} 响 ${parts.length} 根弦  音级 {${pcs}}`,
    );
  }
  ok('伸 2 指 → 槽 4 → F（网页自检里写的就是这条）', slotFromFingers(2) === 4 && slots[4].name === 'F', slots[4].name);
  ok('F 是大横按：6 根弦全响', chordStrings('F').length === 6, String(chordStrings('F').length));
  ok('F 的音级是 {A C F}（实际发音是 F C F A C F）',
    [...new Set(chordNoteNames('F'))].sort().join(' ') === 'A C F',
    [...new Set(chordNoteNames('F'))].sort().join(' '));
  ok('🤘（槽 0）→ C，只响 5 根弦', slotFromFingers(6) === 0 && slots[0].name === 'C' && chordStrings('C').length === 5);
  // 每个库的每个槽都要有和弦，而且都能响出声（不能有"名字在、声不出"的）
  for (const [key, bank] of Object.entries(CHORD_BANKS)) {
    const bad = bank.slots.filter((n) => !resolve(n) || chordStrings(n).length === 0);
    ok(`和弦库 ${key} 的 6 个槽都能出声`, bad.length === 0, bad.join(','));
  }
}

// ---- 变调夹：想听的和弦不变，按的指型换把位（这是"抒情走向显示不对照"的修法） ----
console.log('\n变调夹（变调 = 夹几品）：听的和弦不变，按的指型整体换把位\n');
{
  const pcSetOf = (shape, up = 0) =>
    new Set(chordMidis(shape).map((m) => ((((m + up) % 12) + 12) % 12)));
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  let bad = [];
  let noShape = [];
  let samples = 0;
  for (let t = -12; t <= 12; t++) {
    for (const [bankKey, bank] of Object.entries(CHORD_BANKS)) {
      for (const s of bankSlots(bankKey, t)) {
        samples += 1;
        // 1. 显示名永远等于和弦库里的写法（这就是"对照"的定义）
        if (s.name !== CHORD_BANKS[bankKey].slots[s.slot]) bad.push(`${bankKey}槽${s.slot}@${t} 名字被改了`);
        // 2. 必须能找到一个指型
        if (!s.shape) {
          noShape.push(`${bankKey}/${s.name}@${t}`);
          continue;
        }
        // 3. 那个指型上移 t 品之后，音级必须**正好**等于想听的和弦
        const got = pcSetOf(s.shape, t);
        const want = pcSetOf(resolve(s.name), 0);
        if (!sameSet(got, want)) bad.push(`${bankKey}/${s.name}@${t} 按${s.shape.name}型听出来不对`);
      }
    }
  }
  console.log(`  检查了 ${samples} 个（和弦 × 变调 −12…+12）组合`);
  ok('显示名永远和和弦库标签一致（这就是"对照"）', !bad.some((b) => b.includes('名字被改了')));
  ok('每个组合都有指型（12 个调全覆盖）', noShape.length === 0, noShape.slice(0, 6).join(' '));
  ok('指型上移变调数之后，音级正好等于想听的和弦', !bad.some((b) => b.includes('听出来不对')), bad.slice(0, 4).join(' | '));

  // 具体到用户报的那个例子
  const balladAt5 = bankSlots('ballad', 5);
  console.log('\n  用户报的例子：抒情走向 + 变调 +5');
  console.log(`    下拉标签：      抒情走向（C Am F G Em Dm）`);
  console.log(`    修复前显示：    F Dm A# C Am Gm      ← 对不上`);
  console.log(`    现在显示：      ${balladAt5.map((s) => s.name).join(' ')}`);
  console.log(`    实际要按的指型： ${balladAt5.map((s) => (s.shape ? s.shape.name : '无')).join(' ')}`);
  ok('抒情走向 +5 显示的就是 C Am F G Em Dm', balladAt5.map((s) => s.name).join(' ') === 'C Am F G Em Dm');
  ok('抒情走向 +5 每个指型上移 5 品都等于想听的和弦',
    balladAt5.every((s) => s.shape && sameSet(pcSetOf(s.shape, 5), pcSetOf(resolve(s.name), 0))));

  // 每个库的标签里承诺的和弦，必须和 slots 一模一样（标签不许说谎）
  for (const [key, bank] of Object.entries(CHORD_BANKS)) {
    const m = bank.label.match(/[（(]([^）)]+)[）)]/);
    const promised = m ? m[1].split(/\s+/) : [];
    ok(`和弦库 ${key} 的标签和槽位一致（标签不许说谎）`,
      promised.join(' ') === bank.slots.join(' '),
      `标签[${promised.join(' ')}] vs 槽位[${bank.slots.join(' ')}]`);
  }
}

// ---- 打印一张对照表，方便肉眼核对 ----
console.log('和弦      指型(6→1弦)             组成音              实际音级');
for (const name of names) {
  const shape = resolve(name);
  const frets = shape.frets.map((f) => (f === MUTE ? 'x' : String(f))).join(' ');
  const notes = chordNoteNames(shape).join(' ');
  console.log(`  ${name.padEnd(7)} ${frets.padEnd(22)} ${notes.padEnd(19)} {${chordIntervals(shape).join(',')}}`);
}

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
process.exit(fails.length === 0 ? 0 : 1);
