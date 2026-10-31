/**
 * DOM 接线测试：app.js 里 $('xxx') 找的每个 id，必须在 index.html 里真实存在。
 *
 *   node tools/test_dom_wiring.mjs
 *
 * 为什么要有它：这个项目没有构建步骤，HTML 和 JS 是手写对齐的。
 * 一旦 id 拼错或者忘了加元素，`$('sel-transpose')` 就返回 null，
 * 接着 `els.selTranspose.addEventListener` 直接抛异常 —— 整个 app.js 的初始化中断，
 * 表现是"页面打开什么都没反应"，而且浏览器里只报一行错，很难一眼看出是少了元素。
 * 这类错单测（test_landmarks / test_audio）完全抓不到，因为它们不碰 DOM。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const app = readFileSync(join(WEB, 'js', 'app.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? `  ← ${extra}` : ''}`);
  }
};

console.log('\n[1] index.html 里的 id');
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dupes = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
check('没有重复的 id', dupes.length === 0, dupes.join(', '));
check(`一共 ${htmlIds.length} 个 id`, htmlIds.length > 20);

console.log('\n[2] app.js 里用 $() 查的 id，必须都存在');
const lookup = [...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const missing = [...new Set(lookup)].filter((id) => !htmlIds.includes(id));
check(`查了 ${new Set(lookup).size} 个 id，全部能在 HTML 里找到`, missing.length === 0, missing.join(', '));

console.log('\n[3] getElementById / querySelector 也不能漏');
const byId = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
const missing2 = [...new Set(byId)].filter((id) => !htmlIds.includes(id));
check(`getElementById 的 ${new Set(byId).size} 个 id 都存在`, missing2.length === 0, missing2.join(', '));

console.log('\n[4] 整体变调下拉：选项必须覆盖 12 个调，而且标注不能写错调名');
{
  const block = /<select id="sel-transpose">([\s\S]*?)<\/select>/.exec(html);
  check('sel-transpose 存在且是个 select', !!block);
  const options = [...(block ? block[1] : '').matchAll(/<option value="(-?\d+)"[^>]*>([^<]*)</g)].map((m) => ({
    value: Number(m[1]),
    label: m[2],
  }));
  const values = options.map((o) => o.value);
  check(`有 ${options.length} 个选项`, options.length === 13, String(options.length));
  check('值不重复', new Set(values).size === values.length, values.join(','));
  const want = [0, -1, -2, -3, -4, -5, 1, 2, 3, 4, 5, 6, 7];
  check(`值正好是 ${want.join(',')}`, want.every((v) => values.includes(v)) && values.length === want.length, values.join(','));
  check('默认选 0（原调）', /<option value="0"[^>]*selected/.test(block ? block[1] : ''));

  // 调名必须对：E 降 n 个半音是哪个小调
  const KEY_OF = {
    '-5': 'B', '-4': 'C', '-3': 'C#', '-2': 'D', '-1': 'D#', 0: 'E',
    1: 'F', 2: 'F#', 3: 'G', 4: 'G#', 5: 'A', 6: 'A#', 7: 'B',
  };
  // 之前这里写错过：−3 被标成"C 小调"，其实是 C# 小调（E 降 3 个半音到 C#）
  check('−3 标的是 C#（不是 C）',
    /C#/.test(options.find((o) => o.value === -3)?.label || ''),
    options.find((o) => o.value === -3)?.label);
  check('−4 标的才是 C 小调',
    /C\s*小调/.test(options.find((o) => o.value === -4)?.label || ''),
    options.find((o) => o.value === -4)?.label);
  check('−2 是 D 小调', /D\s*小调/.test(options.find((o) => o.value === -2)?.label || ''));
  check('+5 是 A 小调', /A\s*小调/.test(options.find((o) => o.value === 5)?.label || ''));
  check('0 是 E 小调', /E\s*小调/.test(options.find((o) => o.value === 0)?.label || ''));
  for (const o of options) {
    const wantKey = KEY_OF[String(o.value)];
    check(`变调 ${o.value > 0 ? '+' : ''}${o.value} 的标注里出现 ${wantKey}`,
      (o.label || '').includes(wantKey),
      o.label);
  }
}

console.log('\n[5] app.js 必须真的把变调接上（不能只改 HTML）');
check('取了 sel-transpose 元素', /selTranspose:\s*\$\('sel-transpose'\)/.test(app));
check('有 state.transpose 初值', /transpose:\s*0/.test(app));
check('doPluck 把 transpose 传进 pluck()', /transpose:\s*state\.transpose/.test(app));
check('下拉的 change 事件有监听', /els\.selTranspose\.addEventListener\('change'/.test(app));
check('换调时会刷新"6 根弦"提示', /function updateTransposeHint/.test(app));

console.log('\n[6] 六弦板：HTML / JS / CSS 三边必须对齐');
{
  const css = readFileSync(join(WEB, 'css', 'app.css'), 'utf8');
  // 大字要盖在画面上，得在 .viewport 里面（.viewport 是 position:relative）
  const vp = /<div class="viewport" id="viewport">([\s\S]*?)<\/div>\s*<!-- 六弦板/.exec(html);
  check('pluck-flash 在 .viewport 内部（才能盖在画面上）',
    !!vp && /id="pluck-flash"/.test(vp[1]));
  check('.viewport 是 relative（大字才能定位）', /\.viewport\s*\{[^}]*position:\s*relative/.test(css));
  check('#sb-rows 是空的，由 JS 填', /<div id="sb-rows" class="sb-rows"><\/div>/.test(html));

  // JS 会去加/切这些 class；CSS 里没写就等于"什么都不会发生"（静默失效）
  const toggled = [
    ['sb-row', /querySelectorAll\('\.sb-row'\)|class="sb-row"/],
    ['hit', /classList\.(add|remove|toggle)\('hit'\)/],
    ['sel', /classList\.toggle\('sel'/],
    ['go', /classList\.add\('go'\)/],
    ['pluck-flash', /classList\.(add|remove)\('go'\)/],
    ['tab-chip', /class="tab-chip"/],
  ];
  for (const [cls, used] of toggled) {
    check(`app.js 用了 .${cls}`, used.test(app));
  }
  const need = ['.stringboard', '.sb-rows', '.sb-row', '.sb-row.sel', '.sb-row.hit', '.sb-sym',
    '.sb-num', '.sb-line', '.sb-name', '.sb-count', '.tab-strip', '.tab-chip', '.pluck-flash', '.pluck-flash.go'];
  const missingCss = need.filter((sel) => !css.includes(sel));
  check(`CSS 里这些选择器全都有：${need.join(' ')}`, missingCss.length === 0, missingCss.join(' '));
  check('拨弦动画真的有 keyframes（不是只加了个类）', /@keyframes sbpop/.test(css) && /@keyframes sbring/.test(css) && /@keyframes pflash/.test(css));

  // 手势符号：1弦=☝️ … 6弦=🤘，顺序别写反
  const sym = /const STRING_SYMBOLS = \[([^\]]+)\]/.exec(app);
  check('STRING_SYMBOLS 有 6 个', !!sym && sym[1].split(',').length === 6, sym ? sym[1] : '没找到');
  check('6 弦的符号是 🤘、1 弦是 ☝️（顺序没反）',
    !!sym && /^\s*'🤘'/.test(sym[1]) && /'☝️'\s*$/.test(sym[1]), sym ? sym[1] : '—');
}

console.log('\n[7] 静态作用域：els.* 的每个名字都得是 els 里真有的 key');
{
  const lit = /const els = \{([\s\S]*?)\n\};/.exec(app);
  check('找到了 els 对象字面量', !!lit);
  const keys = new Set(
    [...(lit ? lit[1] : '').matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]),
  );
  check(`els 里有 ${keys.size} 个成员`, keys.size > 25, String(keys.size));

  const used = [...new Set([...app.matchAll(/\bels\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  const bad = used.filter((k) => !keys.has(k));
  check(`用到了 ${used.length} 个 els.*，全都在 els 里定义过`, used.length > 25 && bad.length === 0,
    bad.length ? bad.join(', ') : `只扫到 ${used.length} 个`);

  // 新加的六弦板相关函数必须真的声明了（写成 function / const 都算）
  const decl = (name) =>
    new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=|let\\s+${name}\\s*=)`).test(app);
  for (const fn of ['buildStringBoard', 'setSelectedString', 'showPluckFlash', 'bumpCount',
    'renderTabStrip', 'resetTab', 'tabToText', 'stringButtonsHtml', 'buildStringButtons',
    'flashString', 'updateTransposeHint', 'doPluck']) {
    check(`${fn}() 有声明`, decl(fn));
  }

  // 同名函数声明两次的话，后一个会静默覆盖前一个（我这次就踩过）
  for (const fn of ['flashString', 'buildStringButtons', 'buildStringBoard', 'updateTransposeHint', 'doPluck']) {
    const n = [...app.matchAll(new RegExp(`^function\\s+${fn}\\b`, 'gm'))].length;
    check(`${fn}() 只声明了 1 次`, n === 1, `声明了 ${n} 次`);
  }

  // 六弦板要用到的 state 字段
  for (const f of ['selectedString', 'stringCounts', 'tabHistory', 'transpose']) {
    check(`state.${f} 有初值`, new RegExp(`${f}:`).test(app));
  }
}

console.log('\n[8] 和弦模式：和弦表 / 触发 / 界面三边必须对齐');
{
  const css = readFileSync(join(WEB, 'css', 'app.css'), 'utf8');
  const chordsSrc = readFileSync(join(WEB, 'js', 'chords.js'), 'utf8');
  const audio = readFileSync(join(WEB, 'js', 'audio.js'), 'utf8');

  // app.js 必须真的用了和弦模块（不能只加 HTML 控件）
  check('app.js 导入了 chords.js', /from '\.\/chords\.js'/.test(app));
  for (const sym of ['bankSlots', 'chordNoteNames', 'chordMidis', 'shapeForSounding', 'resolve as resolveChord']) {
    check(`app.js 用到了 ${sym}`, app.includes(sym));
  }
  // 变调夹的修法：显示名**不能**再整体移调（那正是"抒情走向显示对不上"的病根）
  check('app.js 不再把显示名做移调（改成 shapeForSounding 换指型）', !app.includes('chordSoundingName'));
  check('chords.js 导出了 shapeForSounding（听的和弦 → 要按的指型）', /export function shapeForSounding/.test(chordsSrc));
  check('chords.js 有大横按族（12 个调全覆盖，机械平移不用手抄）', /BARRE_FAMILIES/.test(chordsSrc));
  check('chords.js 的槽位名来自和弦库、形状另存（name / shape 分开）',
    /name,\s*\/\/ 要听到的和弦[\s\S]{0,200}shape,/.test(chordsSrc));
  check('变调下没有指型会如实标出来（toneless），不偷偷换和弦', /toneless/.test(app) && /toneless/.test(chordsSrc));

  // ---- 编号一致性：伸 n 根手指 = 第 n 个和弦（和弦按钮上印的、键盘用的也是这个顺序）----
  // 这里踩过坑：和弦模式一开始沿用弦模式的逆序（槽位 = 6 - 手指数），
  // "伸 1 指"选中的是第 6 个和弦，而按钮上写着 1..6、键盘 1-6 从第 1 个开始 —— 两套编号打架。
  check('app.js 有"弦号 ↔ 和弦槽位"的转换函数', /const slotFromStringIndex\s*=/.test(app) && /const stringIndexFromSlot\s*=/.test(app));
  check('slotFromStringIndex 是 5 - s（伸 n 指 = 第 n 个）', /slotFromStringIndex\s*=\s*\(s\)\s*=>\s*5\s*-\s*s/.test(app));
  check('选中和弦时把弦号转成了槽位（不是直接当槽位用）',
    /setChordSelected\(slotFromStringIndex\(stringHand\.snap\.string\)\)/.test(app));
  check('扫和弦时也走同一个转换', /const slot = slotFromStringIndex\(sel\)/.test(app));
  check('和弦板的符号列按"第 i 行 = 伸 i+1 指"来画',
    /STRING_SYMBOLS\[stringIndexFromSlot\(i\)\]/.test(app));
  check('和弦板每行印着编号（1..6）', /sb-num"><b>\$\{i \+ 1\}<\/b>/.test(app));
  check('键盘 n 键 → 槽位 n-1（和弦和单音同一套行序）', /const slot = n - 1;/.test(app));
  check('CSS 管到了和弦板行里的编号 .sb-chord .sb-num b', /\.sb-chord \.sb-num b\b/.test(css));
  check('和弦模式的提示写的是"伸 n 根手指 = 第 n 个"',
    /伸 n 根手指 = 第 n 个和弦/.test(app));

  // ---- "手指数对但弦号全错"那个症状：判定依据必须写在脸上 ----
  // 病根是"校准模板"和"手指数"两条独立的路，模板又几乎每帧都命中（maxDist 0.7 太松）。
  const lm = readFileSync(join(WEB, 'js', 'landmarks.js'), 'utf8');
  check('landmarks.js 有两道闸：距离上限 + margin（打平不采信）',
    /templateMinMargin/.test(lm) && /templateMaxDist: 0\.45/.test(lm));
  check('landmarks.js 记录判定依据 judgedBy', /t\.judgedBy\s*=/.test(lm) && /judgedBy:/.test(lm));
  check('landmarks.js 把判定换算成手指数 countAsJudged', /t\.countAsJudged\s*=/.test(lm) && /countAsJudged:/.test(lm));
  check('landmarks.js 会标记"判定和手指数打架"judgedAgrees', /t\.judgedAgrees\s*=/.test(lm) && /judgedAgrees:/.test(lm));
  check('app.js 面板把"判定依据"写出来（校准模板 / 内置规则）', /判定依据：/.test(app));
  check('app.js 会在判定与手指数不符时弹警告', /判定和手指数不符/.test(app));
  check('app.js 的演奏状态行会标出"判定依据在哪"', /（校准模板）|（模板没把握·用规则）/.test(app));
  check('app.js 演奏状态行会写"这个弦号 = 第几个和弦"', /个和弦\$\{basis\}/.test(app) || /第 \$\{slotFromStringIndex\(s\.string\) \+ 1\} 个和弦/.test(app));
  check('CSS 管到了判定警告 .judge.bad', /\.judge\.bad\b/.test(css));
  check('有 ?nocal=1 可以临时停用校准模板（一眼分清是模板还是规则）',
    /params\.get\('nocal'\)/.test(app));
  // audio.js 必须真的提供齐奏接口，而且支持每根弦不同品位
  check('audio.js 有 strumChord()', /strumChord\s*\(/.test(audio));
  check('strumChord 给每根弦单独传品位', /fret:\s*fretOf\.get\(string\)/.test(audio));
  check('audio.js 有混响（ConvolverNode）', /createConvolver/.test(audio));
  check('audio.js 有 setReverb()', /setReverb\s*\(/.test(audio));
  check('混响脉冲响应是纯函数（Node 可测）', /export function impulseData/.test(audio));

  // 和弦表本身
  const chordNames = [...chordsSrc.matchAll(/^\s{2}'?([A-G][#b]?[A-Za-z0-9/]*)'?:\s*\{\s*root:/gm)].map((m) => m[1]);
  check(`chords.js 里定义了 ${chordNames.length} 个和弦`, chordNames.length >= 20);
  for (const n of ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7', 'Cmaj7', 'Fmaj7', 'Am7', 'Dm7', 'Gsus4']) {
    check(`C 调情歌必备和弦 ${n} 在表里`, chordNames.includes(n));
  }
  // 指型必须是 6 个数字（含 -1），不能漏弦
  const shapes = [...chordsSrc.matchAll(/frets:\s*\[([^\]]+)\]/g)].map((m) => m[1].split(',').map((s) => s.trim()));
  check(`所有指型都是 6 根弦（查了 ${shapes.length} 个）`, shapes.every((s) => s.length === 6));
  check('指型里出现了按品（不全是 0/-1）', shapes.some((s) => s.some((f) => Number(f) > 0)));
  check('指型里有闷掉的弦（-1）', shapes.some((s) => s.some((f) => Number(f) < 0) || s.includes('MUTE')));

  // 和弦库
  const banks = [...chordsSrc.matchAll(/^\s{2}\w+:\s*\{\s*label:[^\n]*?slots:\s*\[([^\]]+)\]/gm)];
  check(`定义了 ${banks.length} 个和弦库`, banks.length >= 3);
  check('每个和弦库都是 6 个槽位', banks.every((b) => b[1].split(',').length === 6));

  // 触发链路：手势走的就是原来的识别，只是把"弦号"当"和弦号"
  check('handleStrum 里按模式分流', /state\.chordMode\s*\n?\s*\?\s*doStrumChord/.test(app));
  check('和弦模式复用了预选高亮', /setChordSelected\(/.test(app));
  check('renderBoard 按模式选板子', /function renderBoard\(/.test(app) && /state\.chordMode\s*\)\s*buildChordBoard/.test(app));
  check('有键盘 1-6 快捷触发', /addEventListener\('keydown'/.test(app));
  check('和弦模式走的是齐奏而不是单音', /sampler\.strumChord\(/.test(app));

  for (const fn of ['doStrumChord', 'flashChord', 'buildChordBoard', 'chordButtonsHtml',
    'buildChordButtons', 'buildChordAll', 'buildChordBankSelect', 'setChordMode',
    'updateChordHint', 'updateReverb', 'refreshChordUi', 'slotChord', 'currentBank']) {
    check(`${fn}() 有声明`, new RegExp(`(function\\s+${fn}\\b|const\\s+${fn}\\s*=)`).test(app));
  }
  for (const fn of ['doStrumChord', 'buildChordBoard', 'setChordMode', 'flashChord']) {
    const n = [...app.matchAll(new RegExp(`^function\\s+${fn}\\b`, 'gm'))].length;
    check(`${fn}() 只声明了 1 次`, n === 1, `声明了 ${n} 次`);
  }
  for (const f of ['chordMode', 'bankKey', 'chordCounts', 'lastChord']) {
    check(`state.${f} 有初值`, new RegExp(`${f}:`).test(app));
  }

  // CSS
  for (const cls of ['chord-toggle', 'chord-row', 'chord-all', 'chord-group', 'sb-chord', 'sb-frets', 'chord-chip']) {
    check(`CSS 里有 .${cls}`, new RegExp(`\\.${cls}\\b`).test(css));
  }
  check('body.chord-mode 有样式', /body\.chord-mode/.test(css));
  // 变调夹下的"实际指型"标注：HTML 里用了 <u>，CSS 必须管到（不然就是浏览器默认下划线）
  check('CSS 管到了和弦名后面的指型标注 .sb-num u', /\.sb-num u\b/.test(css));
  check('CSS 管到了和弦按钮上的指型标注 .chord-chip u', /\.chord-chip u\b/.test(css));
  check('CSS 管到了"没指型"状态 .toneless', /\.toneless\b/.test(css));
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
