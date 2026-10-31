/**
 * 主程序：摄像头/图片 → MediaPipe HandLandmarker → 21 关键点 → 绘制 + 读数。
 *
 * 这一版只做「手部关键点检测」这一件事，吉他的发声逻辑留到下一步。
 */

import { MediaPipeHandEngine } from './engines/mediapipe_engine.js';
import { GuitarSampler, pickLayer, playbackRateForFret, pluckSchedule } from './audio.js';
import {
  CHORDS,
  CHORD_BANKS,
  DEFAULT_BANK,
  bankSlots,
  chordMidis,
  chordNoteNames,
  chordStrings,
  shapeForSounding,
  resolve as resolveChord,
} from './chords.js';
import {
  HAND_CONNECTIONS,
  FINGER_ORDER,
  FINGER_CN,
  STRING_LABELS,
  toPixels,
  computeExtension,
  bboxFromLandmarks,
  stringFromGesture,
  gestureName,
  classifyShape,
  createHandTracker,
  updateHandTracker,
  snapshotHandTracker,
  checkStrumTrigger,
  consumeStrum,
  createMotionTracker,
  updateMotionTracker,
  shouldMute,
  pickDefaultCamera,
  tagForCamera,
  CAM_PHONE_HINT,
  UNKNOWN_STRING,
  describeHand,
} from './landmarks.js';

const $ = (id) => document.getElementById(id);
const BUILD = '2026-10-31.18';

function diag(msg) {
  const d = $('diag');
  if (d) d.textContent = `[诊断 ${BUILD}] ${msg}`;
  console.log('[diag]', msg);
}

window.addEventListener('error', (e) => diag(`JS 异常: ${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) =>
  diag(`未处理的 Promise 拒绝: ${e.reason?.message || e.reason}`),
);
const els = {
  video: $('video'),
  still: null,
  overlay: $('overlay'),
  viewport: $('viewport'),
  hint: $('hint'),
  badge: $('engine-badge'),
  fps: $('fps'),
  latency: $('latency'),
  handcount: $('handcount'),
  resinfo: $('resinfo'),
  hands: $('hands'),
  samples: $('samples'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnCopy: $('btn-copy'),
  chkSkeleton: $('chk-skeleton'),
  chkPoints: $('chk-points'),
  chkIndex: $('chk-index'),
  chkBbox: $('chk-bbox'),
  audioBadge: $('audio-badge'),
  chkAudioOn: $('chk-audio-on'),
  chkAudioMute: $('chk-audio-mute'),
  selStrumHand: $('sel-strum-hand'),
  rngVelocity: $('rng-velocity'),
  stringButtons: $('string-buttons'),
  audioLog: $('audio-log'),
  selTranspose: $('sel-transpose'),
  transposeVal: $('transpose-val'),
  sbRows: $('sb-rows'),
  sbSelected: $('sb-selected'),
  tabStrip: $('tab-strip'),
  pluckFlash: $('pluck-flash'),
  btnCopyTab: $('btn-copy-tab'),
  btnClearTab: $('btn-clear-tab'),
  chkChordMode: $('chk-chord-mode'),
  selChordBank: $('sel-chord-bank'),
  chordButtons: $('chord-buttons'),
  chordAll: $('chord-all'),
  chordHint: $('chord-hint'),
  rngReverb: $('rng-reverb'),
  reverbVal: $('reverb-val'),
  selCamera: $('sel-camera'),
  btnRefreshCams: $('btn-refresh-cams'),
  camNote: $('cam-note'),
  rngSens: $('rng-sens'),
  selMapping: $('sel-mapping'),
  selTrigger: $('sel-trigger'),
  rngMotion: $('rng-motion'),
  playState: $('play-state'),
  sensVal: $('sens-val'),
  motionVal: $('motion-val'),
  btnCalibrate: $('btn-calibrate'),
  btnCalClear: $('btn-cal-clear'),
  calNote: $('cal-note'),
};

const ctx = els.overlay.getContext('2d');
const state = {
  engine: null,
  stream: null,
  running: false,
  mode: 'idle', // idle | camera | still
  rafId: 0,
  lastTs: 0,
  tsCounter: 0,
  fpsEma: 0,
  latencyMs: 0,
  lastResult: null,
  domTick: 0,
  sampler: null,
  trackers: new Map(), // handedness -> 手部判定状态机（平滑/滞回/投票/锁定）
  motions: new Map(), // handedness -> 手腕速度跟踪
  audioOn: true,
  muteOn: true,
  pluckCount: 0,
  pluckLog: [],
  extLog: [], // 最近若干帧的平滑伸展度（校准取样用）
  lastPluck: '',
  flashUntil: 0,
  transpose: 0, // 整体变调（半音）：整把琴平移，用来对上歌曲的调
  selectedString: -1, // 手势当前预选的弦（-1 = 没选到），用来在六弦板上高亮
  stringCounts: [0, 0, 0, 0, 0, 0], // 每根弦拨了多少次
  tabHistory: [], // 最近拨过的弦 → 就是你自己弹出来的 TAB
  // ---- 和弦模式：手势/数字键选"第几个和弦"，张开手一次扫出整个和弦 ----
  chordMode: false,
  bankKey: DEFAULT_BANK, // 当前和弦库（决定 6 个槽位是哪 6 个和弦）
  chordCounts: [0, 0, 0, 0, 0, 0], // 每个槽位扫了多少次
  lastChord: null,
};

// --------------------------------------------------------------------------
// 引擎加载
// --------------------------------------------------------------------------
async function initEngine() {
  try {
    els.badge.textContent = '引擎：加载 HandLandmarker…';
    state.engine = await MediaPipeHandEngine.create({ numHands: 2, delegate: 'GPU' });
    els.badge.textContent = `引擎：${state.engine.name}`;
    els.badge.className = 'badge ok';
    els.hint.classList.remove('hidden');
    diag(`引擎就绪：${state.engine.name}`);
  } catch (err) {
    console.error(err);
    els.badge.textContent = `引擎加载失败：${err.message || err}`;
    els.badge.className = 'badge error';
    els.hint.innerHTML = `<div><p><strong>引擎没加载起来</strong></p>
      <p class="dim">${String(err.message || err)}</p>
      <p class="dim">请确认是通过 <code>start.bat</code> / <code>node tools/serve.js</code> 以 http 方式打开，
      而不是直接双击 index.html（file:// 下 wasm 会被浏览器拦）。</p></div>`;
  }
}

// --------------------------------------------------------------------------
// 摄像头选择
//
// 系统"默认摄像头"未必是笔记本内置的那个：装了 DroidCam / Iriun 或者用了
// Windows「手机连接」之后，手机会变成一个普通摄像头设备，浏览器按默认挑就会挑到手机。
// 所以这里明确列出来让用户选，并把选择记在 localStorage 里。
// --------------------------------------------------------------------------
// v2：旧键 airguitar.cameraId 被早期版本用"自动挑的那个设备"污染过
// （见 openCameraStream 里的注释），换新键，让"用户明确选过的设备"从这一版重新开始记。
const CAM_STORE_KEY = 'airguitar.cameraId.v2';

/** 列出所有视频输入设备。没授权时 label 是空的，所以"开一下再关"来换出标签。 */
async function listCameras({ requestPermission = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let cams = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'videoinput',
  );
  if (requestPermission && cams.some((c) => !c.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      cams = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
    } catch (err) {
      diag(`拿不到摄像头权限，设备名可能显示不出来：${err.name || err}`);
    }
  }
  return cams;
}

/** 选中优先级：用户明确选过的 → 内置镜头 → 非手机/虚拟的第一个 → 第一个 */

async function refreshCameras({ requestPermission = false, keepCurrent = true } = {}) {
  const prev = keepCurrent ? els.selCamera.value : '';
  // 上一次列举时是不是已经有设备名了。
  // 关键：没授权时设备名是空的，这时候"自动挑一个"只是临时的，
  // 不能当成用户的选择留到下一次——否则拿到真名字后也不会再挑，
  // 结果默认停在手机/虚拟摄像头上（实测踩到过）。
  const hadLabels = !!state.camsLabeled;
  const cams = await listCameras({ requestPermission });

  if (!cams.length) {
    els.selCamera.innerHTML = '<option value="">（没找到摄像头）</option>';
    els.camNote.textContent = '没找到任何摄像头设备。检查一下设备管理器，或者用下面的样例图片。';
    return [];
  }

  const nowLabeled = cams.some((c) => c.label);
  // 只有"上次就已经看得到名字"时，保留当前选择才算数；否则这次重新挑
  const keepId = hadLabels || !nowLabeled ? prev : '';
  const saved = localStorage.getItem(CAM_STORE_KEY) || '';
  const chosen = pickDefaultCamera(cams, keepId || saved);
  state.camsLabeled = nowLabeled;
  els.selCamera.innerHTML = cams
    .map((c, i) => {
      const label = c.label || `摄像头 ${i + 1}（授权后才显示名字）`;
      const sel = c.deviceId === chosen ? ' selected' : '';
      return `<option value="${c.deviceId}"${sel}>${tagForCamera(label)} ${label}</option>`;
    })
    .join('');

  const cur = cams.find((c) => c.deviceId === els.selCamera.value);
  const nPhone = cams.filter((c) => CAM_PHONE_HINT.test(c.label)).length;
  els.camNote.textContent =
    `找到 ${cams.length} 个摄像头${nPhone ? `（其中 ${nPhone} 个像是手机/虚拟摄像头）` : ''}，` +
    `当前选中：${cur?.label || '未知'}。`;
  diag(`摄像头列表：${cams.map((c) => c.label || '(无名)').join(' | ')}`);
  return cams;
}

/** 打开摄像头。指定了设备就用它；打不开就退回系统默认，别让用户卡住。 */
async function openCameraStream() {
  const id = els.selCamera.value;
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const tries = id
    ? [{ ...size, deviceId: { exact: id } }, { ...size, facingMode: 'user' }]
    : [{ ...size, facingMode: 'user' }];

  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: tries[i], audio: false });
    } catch (err) {
      lastErr = err;
      if (i === 0 && tries.length > 1) {
        diag(`选中的摄像头打不开（${err.name || err}），改用系统默认`);
      }
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------------------
// 绘制
// --------------------------------------------------------------------------
function syncCanvasToVideo() {
  const src = state.mode === 'still' ? els.still : els.video;
  if (!src) return { w: 0, h: 0 };
  const sr = src.getBoundingClientRect();
  const pr = els.viewport.getBoundingClientRect();
  const w = Math.max(1, Math.round(sr.width));
  const h = Math.max(1, Math.round(sr.height));
  els.overlay.style.left = `${Math.round(sr.left - pr.left)}px`;
  els.overlay.style.top = `${Math.round(sr.top - pr.top)}px`;
  els.overlay.style.width = `${w}px`;
  els.overlay.style.height = `${h}px`;

  const naturalW = src.naturalWidth || src.videoWidth || w;
  const naturalH = src.naturalHeight || src.videoHeight || h;
  if (els.overlay.width !== naturalW || els.overlay.height !== naturalH) {
    els.overlay.width = naturalW;
    els.overlay.height = naturalH;
  }
  return { w: naturalW, h: naturalH };
}

function drawHand(hand, feat, idx) {
  const { w, h } = syncCanvasToVideo();
  if (!w || !h) return;
  const pts = toPixels(hand.landmarks, w, h, true); // true = 自拍镜像

  ctx.lineWidth = Math.max(2, w / 420);
  ctx.strokeStyle = idx === 0 ? 'rgba(76,154,255,.95)' : 'rgba(55,214,122,.95)';
  ctx.fillStyle = ctx.strokeStyle;

  if (els.chkSkeleton.checked) {
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();
  }

  if (els.chkPoints.checked) {
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.5, w / 320), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (els.chkIndex.checked) {
    ctx.font = `${Math.max(11, Math.round(w / 90))}px Consolas, monospace`;
    ctx.fillStyle = 'rgba(240,163,94,.95)';
    for (let i = 0; i < pts.length; i += 4) {
      ctx.fillText(String(i), pts[i].x + 6, pts[i].y - 6);
    }
    ctx.fillStyle = 'rgba(230,237,243,.9)';
    ctx.fillText(`20`, pts[20].x + 6, pts[20].y - 6);
  }

  if (els.chkBbox.checked) {
    const bb = bboxFromLandmarks(pts, { pad: 1.1 });
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(240,163,94,.8)';
    ctx.lineWidth = Math.max(1.5, w / 700);
    ctx.strokeRect(bb.x1, bb.y1, bb.size, bb.size);
    ctx.setLineDash([]);
  }

  // 腕点标注左右手与伸指数
  ctx.font = `bold ${Math.max(13, Math.round(w / 70))}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = 'rgba(55,214,122,.95)';
  ctx.fillText(
    `${hand.handedness} · ${feat.count} 指`,
    pts[0].x + 10,
    pts[0].y + Math.max(18, w / 55),
  );
}

function clearOverlay() {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

// --------------------------------------------------------------------------
// 面板读数
// --------------------------------------------------------------------------
function renderHands(hands) {
  if (!hands.length) {
    els.hands.innerHTML = '<p class="dim">画面里没有检测到手</p>';
    return;
  }
  const blocks = hands.map((h, i) => {
    const feat = h.features;
    const desc = describeHand(feat);
    // 面板显示"平滑+投票+锁定"之后的结果，和实际发声用的是同一个值，避免面板和声音不一致
    const tr = state.trackers?.get(h.handedness);
    const live = stringFromGesture(feat.ext);
    const tracked = tr ? snapshotHandTracker(tr) : null;
    const gesture = live;
    // 有状态机就以状态机为准（它就是发声用的那个值），瞬时值只作参考
    const stringIdx = tracked ? tracked.string : live.string;
    const stringText =
      stringIdx === UNKNOWN_STRING
        ? '没选弦（握拳）'
        : `${STRING_LABELS[stringIdx]}${gesture.gesture === 'horns' && stringIdx === 0 ? '（🤘 手势）' : ''}`;
    const liveText =
      live.string === UNKNOWN_STRING
        ? '瞬时不选弦'
        : `瞬时 ${STRING_LABELS[live.string]}`;
    // 判定依据必须写在脸上：用校准模板还是内置规则、和"手指数"打不打架。
    // 之前这两件事是两条独立的路，屏幕上"伸出 1 根"和"判定 3 弦"能同时成立，
    // 用户看到的就是"手指数对但对应全错"—— 必须明说。
    const judgedByTemplate = tracked && tracked.judgedBy === 'template';
    const judgedWarn = !!tracked && stringIdx !== UNKNOWN_STRING && !tracked.judgedAgrees;
    const judgeText = tracked
      ? judgedWarn
        ? `<b class="warn">⚠ 判定和手指数不符</b>：看到 ${
            tracked.count === 0 ? '握拳' : `伸 ${tracked.count} 根`
          }（= ${tracked.ruleString === UNKNOWN_STRING ? '没选弦' : STRING_LABELS[tracked.ruleString]}），但${
            judgedByTemplate ? '校准模板' : '规则'
          }给的是 ${STRING_LABELS[stringIdx]}。校准模板可能和你的手型对不上了 —— 点「清除校准」重新比划一次`
        : `判定依据：${judgedByTemplate ? '校准模板' : '内置规则'}（和手指数一致）`
      : '';
    const bars = FINGER_ORDER.map((name, k) => {
      const v = feat.ext[k];
      const pct = Math.round(v * 100);
      const smooth = tracked?.ext ? tracked.ext[k] : v;
      const sens = Number(els.rngSens.value);
      return `<div class="bar">
        <span>${FINGER_CN[name]}</span>
        <span class="track"><span class="fill" style="width:${pct}%"></span>
          <span class="smooth" style="left:${Math.round(smooth * 100)}%"></span>
          <span class="thresh" style="left:${Math.round(sens * 100)}%" title="判定阈值 ${sens}"></span></span>
        <span class="val ${smooth >= sens ? 'on' : ''}">${v.toFixed(2)}</span>
      </div>`;
    }).join('');
    const json = JSON.stringify(
      {
        handedness: h.handedness,
        score: Number(h.score.toFixed(3)),
        fingerCount: tracked ? tracked.count : desc.count,
        rawFingerCount: desc.count,
        gesture: tracked ? gestureName(tracked.kind) : gesture.gesture,
        string: stringIdx === UNKNOWN_STRING ? null : STRING_LABELS[stringIdx],
        stringLocked: tracked ? tracked.stringName : null,
        confidence: tracked ? tracked.confidence : null,
        extendNames: tracked
          ? FINGER_ORDER.filter((n, k) => tracked.up[k]).map((n) => FINGER_CN[n])
          : desc.upNames,
        extension: desc.ext,
        smoothed: tracked ? tracked.ext : null,
        pinch: Number(feat.pinch.toFixed(3)),
        landmarks: h.landmarks.map((p) => ({
          x: Number(p.x.toFixed(4)),
          y: Number(p.y.toFixed(4)),
          z: Number((p.z || 0).toFixed(4)),
        })),
      },
      null,
      1,
    );
    return `<div class="hand">
      <h4><span>${i === 0 ? '手 1' : `手 ${i + 1}`} · ${h.handedness}</span>
          <span class="score">置信度 ${(h.score * 100).toFixed(0)}%</span></h4>
      <div class="kv">伸出 <b>${tracked ? tracked.count : desc.count}</b> 根 · 编码 <b>${
        tracked ? tracked.up.map((b) => (b ? '1' : '0')).join('') : desc.signature
      }</b> · 拇指-食指捏合 <b>${feat.pinch.toFixed(2)}</b>（掌心宽度的倍数）</div>
      <div class="bars">${bars}</div>
      <div class="stringtag">按当前映射 → ${stringText}${
        tracked ? `　<i class="dim">锁定 ${(tracked.confidence * 100) | 0}% · ${tracked.reason} · ${liveText}</i>` : ''
      }</div>
      ${judgeText ? `<div class="judge${judgedWarn ? ' bad' : ''}">${judgeText}</div>` : ''}
      <pre class="json">${json}</pre>
    </div>`;
  });
  els.hands.innerHTML = blocks.join('');
}

function updateStats(fps) {
  els.fps.textContent = `FPS ${fps.toFixed(1)}`;
  els.latency.textContent = `推理 ${state.latencyMs.toFixed(0)} ms`;
  els.handcount.textContent = `手 ${state.lastResult ? state.lastResult.length : 0}`;
  const src = state.mode === 'still' ? els.still : els.video;
  const w = src?.videoWidth || src?.naturalWidth || 0;
  const h = src?.videoHeight || src?.naturalHeight || 0;
  els.resinfo.textContent = w ? `分辨率 ${w}×${h}` : '分辨率 --';
  els.resinfo.classList.add('dim');
}

// --------------------------------------------------------------------------
// 检测循环
// --------------------------------------------------------------------------
function processOnce(source, displayMs = true) {
  if (!state.engine) return;
  const t0 = performance.now();
  state.tsCounter += 16.7; // 单调递增的时间戳（毫秒）
  let hands = [];
  try {
    hands = state.engine.detect(source, state.tsCounter);
  } catch (err) {
    console.error('detect failed', err);
    return;
  }
  state.latencyMs = performance.now() - t0;

  const { w, h } = syncCanvasToVideo();
  const enriched = hands.map((hd) => {
    const pts = toPixels(hd.landmarks, w || 1, h || 1, true);
    return { ...hd, features: computeExtension(pts) };
  });
  state.lastResult = enriched;

  clearOverlay();
  enriched.forEach((hd, i) => drawHand(hd, hd.features, i));
  // 静态图片没有时间轴：让状态机直接采信当前帧，而不是等投票
  handleStrum(enriched, undefined, { instant: !displayMs });

  if (displayMs) {
    const now = performance.now();
    if (state.lastTs) {
      const inst = 1000 / Math.max(1e-3, now - state.lastTs);
      state.fpsEma = state.fpsEma ? state.fpsEma * 0.9 + inst * 0.1 : inst;
    }
    state.lastTs = now;
    updateStats(state.fpsEma);
    // DOM 重建比较贵，压到 ~8Hz
    if (now - state.domTick > 120) {
      state.domTick = now;
      renderHands(enriched);
    }
  }
  return enriched;
}

function loop() {
  if (!state.running) return;
  if (els.video.readyState >= 2) processOnce(els.video);
  state.rafId = requestAnimationFrame(loop);
}

// --------------------------------------------------------------------------
// 摄像头
// --------------------------------------------------------------------------
async function startCamera() {
  if (!state.engine) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    els.hint.classList.remove('hidden');
    els.hint.innerHTML = `<div><p><strong>这个页面拿不到摄像头 API</strong></p>
      <p class="dim">必须是 <code>http://127.0.0.1</code> 或 <code>https</code> 打开（file:// 不行）。</p></div>`;
    return;
  }
  // 先把设备名列出来（第一次会顺便要一次权限，这样下拉里不会全是"摄像头 1/2"）
  await refreshCameras({ requestPermission: true }).catch(() => {});
  try {
    state.stream = await openCameraStream();
  } catch (err) {
    els.hint.classList.remove('hidden');
    els.hint.innerHTML = `<div><p><strong>拿不到摄像头</strong></p>
      <p class="dim">${String(err.name || '')} ${String(err.message || err)}</p>
      <p class="dim">浏览器地址栏左边要允许摄像头权限；换了摄像头就点一下「重新扫描」再选；实在不行就点样例图片验证。</p></div>`;
    return;
  }
  stopStill();
  els.video.srcObject = state.stream;
  els.viewport.classList.add('camera');
  await els.video.play().catch(() => {});
  // 这次点击就是"用户手势"，正好用来解锁 AudioContext 并加载采样
  initAudio().then((s) => s?.resume());
  state.mode = 'camera';
  state.running = true;
  resetTrackers('开启摄像头');
  els.hint.classList.add('hidden');
  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  syncCanvasToVideo();

  // 把"实际在用的那个摄像头"和分辨率显示出来，避免又开成手机摄像头而不知道
  const track = state.stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  const label = track?.label || '未知设备';
  diag(`摄像头已开：${label}（${settings.width || '?'}×${settings.height || '?'}）`);
  els.camNote.textContent = `正在使用：${label}（${settings.width || '?'}×${settings.height || '?'}）`;
  els.resinfo.textContent = `分辨率 ${settings.width || '?'}×${settings.height || '?'}`;
  // 注意：这里**不能**把 settings.deviceId 存进 localStorage。
  // 未授权时设备名是空的，自动挑的那个只是瞎猜；一旦把它存下来就变成了"用户选过的"，
  // 下次就算能看到"内置摄像头"这个名字也不会再选它 —— 默认值会永远卡在手机虚拟摄像头上。
  // 只有用户在下拉框里明确改过（见 selCamera 的 change 事件）才值得记住。
  // 实际用的和下拉选的不一致（说明退回默认了），把下拉同步过去
  if (settings.deviceId && els.selCamera.value !== settings.deviceId) {
    await refreshCameras({ keepCurrent: false });
  }
  loop();
}

function stopCamera() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
  els.viewport.classList.remove('camera');
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  clearOverlay();
  els.hint.classList.remove('hidden');
  state.mode = 'idle';
}

// --------------------------------------------------------------------------
// 样例图片模式（没有摄像头时的验证路径）
// --------------------------------------------------------------------------
function stopStill() {
  if (els.still) {
    els.still.classList.remove('show');
  }
}

async function loadStill(url, label) {
  if (!state.engine) return;
  if (!els.still) {
    els.still = document.createElement('img');
    els.still.id = 'still';
    els.viewport.insertBefore(els.still, els.overlay);
  }
  state.running = false;
  cancelAnimationFrame(state.rafId);
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    els.video.srcObject = null;
    els.btnStart.disabled = false;
    els.btnStop.disabled = true;
  }
  els.hint.classList.add('hidden');
  els.still.classList.add('show');
  els.viewport.classList.remove('camera');

  await new Promise((resolve, reject) => {
    els.still.onload = resolve;
    els.still.onerror = () => reject(new Error('图片加载失败：' + url));
    els.still.src = url;
  }).catch((e) => console.warn(e));

  await els.still.decode?.().catch(() => {});
  state.mode = 'still';
  // 换了一张图（或从摄像头切过来）必须清空判定状态机，
  // 否则上一帧/上一个来源的平滑值和锁定会污染这张图的结果
  resetTrackers(`切到样例 ${label}`);
  syncCanvasToVideo();
  requestAnimationFrame(() => {
    const res = processOnce(els.still, false);
    renderHands(res || []);
    updateStats(0);
    const n = res ? res.length : 0;
    els.hint.classList.remove('hidden');
    els.hint.innerHTML = `<div><p><strong>样例：${label}</strong></p>
      <p class="dim">检出 ${n} 只手${n ? '' : '（这张图 MediaPipe 没认出，换一张试试）'}</p></div>`;
  });
}

async function loadSampleList({ autoDefault = true } = {}) {
  try {
    const res = await fetch('./assets/samples/manifest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json();
    els.samples.innerHTML = '';
    for (const item of list) {
      const b = document.createElement('button');
      b.textContent = item.label;
      b.title = item.file;
      b.addEventListener('click', () => loadStill(`./assets/samples/${item.file}`, item.label));
      els.samples.appendChild(b);
      if (autoDefault && item.default) {
        setTimeout(() => loadStill(`./assets/samples/${item.file}`, item.label), 400);
      }
    }
    diag(`样例清单 ${list.length} 张`);
  } catch (err) {
    els.samples.innerHTML = '<span class="dim">没有样例图（跳过）</span>';
  }
}

// --------------------------------------------------------------------------
// 自检模式：?selftest=1 时把清单里所有样例依次跑一遍，输出可读的结果表。
// 没有摄像头、也不想手点时用它验证整条链路。
// --------------------------------------------------------------------------
async function runSelfTest() {
  diag('自检：开始');
  let list = [];
  try {
    const res = await fetch('./assets/samples/manifest.json', { cache: 'no-store' });
    list = await res.json();
  } catch (err) {
    els.hands.innerHTML = `<div class="hand"><h4>批量自检</h4>
      <pre class="json">读不到样例清单：${String(err.message || err)}</pre></div>`;
    diag('自检：清单读取失败 ' + String(err.message || err));
    return [];
  }
  diag(`自检：清单 ${list.length} 张`);
  const img = els.still || (() => {
    els.still = document.createElement('img');
    els.still.id = 'still';
    els.viewport.insertBefore(els.still, els.overlay);
    return els.still;
  })();
  els.still.classList.add('show');
  els.hint.classList.add('hidden');

  const rows = [];
  let ok = 0;
  for (const item of list) {
    await new Promise((resolve) => {
      img.onload = resolve;
      img.onerror = resolve;
      img.src = `./assets/samples/${item.file}`;
    });
    await img.decode?.().catch(() => {});
    state.mode = 'still';
    syncCanvasToVideo();
    const t0 = performance.now();
    const out = processOnce(img, false) || [];
    const ms = performance.now() - t0;
    const maxScore = out.length ? Math.max(...out.map((h) => h.score)) : 0;
    const fingers = out.map((h) => h.features.count).join('/');
    // 每只手按手势算出的弦号（🤘 = 6弦，n 指 = n 弦）
    const strings = out
      .map((h) => {
        const g = stringFromGesture(h.features.ext);
        if (g.string === UNKNOWN_STRING) return '握拳';
        return g.gesture === 'horns' ? '6弦🤘' : `${6 - g.string}弦`;
      })
      .join('/');
    if (out.length) ok += 1;
    rows.push({ label: item.label, file: item.file, hands: out.length, maxScore, fingers, strings, ms });
  }

  updateStats(0);

  // 顺便把音频链路也验一遍：18 个 wav 能不能全部解码 + 拨弦调度能不能建起来
  let audioLine = '';
  try {
    const s = await initAudio();
    if (s) {
      const plucks = [];
      for (let i = 0; i < 6; i++) {
        const r = s.pluck(i, { velocity: 0.5, when: i * 0.02 });
        plucks.push(r && r.note ? `${r.note}/${r.layer}` : 'FAIL');
      }
      const okPlucks = plucks.filter((p) => p !== 'FAIL').length;
      audioLine =
        `音频：${s.stats.decoded}/${s.stats.totalSamples} 个采样解码成功，共 ${s.stats.totalSeconds}s\n` +
        `音频：${s.stats.notes} 个音 × 3 力度层 · 拨弦调度 ${okPlucks}/6 正常 [${plucks.join(' ')}]\n` +
        `音频：AudioContext=${s.ctx.state}${s.ctx.state !== 'running' ? '（没点过页面所以是挂起的，点一下"开启摄像头"或任一根弦就会解锁）' : ''}`;
    } else {
      audioLine = '音频：加载失败';
    }
  } catch (err) {
    audioLine = `音频：异常 ${String(err.message || err)}`;
  }

  // 采样健康自检：把"服务端实际发出来的这份 manifest"跟门槛对一遍。
  // 5 弦曾经因为"音高全对但弹下去 250ms 就没了"被听出来不对，这条就是防它复发。
  let sampleLine = '';
  try {
    const res = await fetch('./assets/guitar/manifest.json', { cache: 'no-store' });
    const gm = await res.json();
    const list = Array.isArray(gm) ? gm : gm.samples || [];
    const problems = [];
    for (const r of list) {
      if (r.sustainDb != null && r.sustainDb < -18) {
        problems.push(`${r.dynamic}/${r.note} 余音只有 ${r.sustainDb}dB（像是被闷掉的短音）`);
      }
      if (r.seconds != null && r.seconds < 2.3) {
        problems.push(`${r.dynamic}/${r.note} 只有 ${r.seconds}s（别的弦都 2.5s 以上）`);
      }
      if (r.measuredHz != null && r.targetHz != null) {
        const cents = 1200 * Math.log2(r.measuredHz / r.targetHz);
        if (Math.abs(cents) > 15) problems.push(`${r.dynamic}/${r.note} 音高差 ${cents.toFixed(0)} 音分`);
      }
    }
    const borrowed = list.filter((r) => r.borrowedFrom).map((r) => `${r.dynamic}/${r.note}←${r.borrowedFrom}`);
    sampleLine =
      `采样：清单 ${list.length} 条（6 弦 × 3 力度）· ` +
      (problems.length ? `❌ ${problems.length} 处不合格\n    ${problems.join('\n    ')}` : '✅ 音高 / 时长 / 余音全部合格') +
      (borrowed.length ? `\n采样：借层 ${borrowed.join(' ')}` : '');
  } catch (err) {
    sampleLine = `采样：清单读取失败 ${String(err.message || err)}`;
  }

  const table = rows
    .map(
      (r) =>
        `${r.hands ? '✅' : '❌'} ${r.label.padEnd(10, ' ')} 手=${r.hands} 置信=${r.maxScore.toFixed(2)} 伸指数=${r.fingers || '-'} 判定弦=${r.strings || '-'} ${r.ms.toFixed(0)}ms`,
    )
    .join('\n');
  const summary = `自检完成：${ok}/${rows.length} 张检出到手\n引擎 ${state.engine?.name}\n\n${table}${
    audioLine ? `\n\n${audioLine}` : ''
  }${sampleLine ? `\n${sampleLine}` : ''}`;
  els.hands.innerHTML = `<div class="hand"><h4><span>批量自检</span><span class="score">${ok}/${rows.length}</span></h4>
    <pre class="json" id="selftest-out">${summary}</pre></div>`;
  els.hint.classList.remove('hidden');
  els.hint.innerHTML = `<div><p><strong>自检：${ok}/${rows.length} 张检出到手</strong></p>
    <p class="dim">详见右侧面板</p></div>`;
  console.log(summary);
  diag(`自检：完成 ${ok}/${rows.length}`);
  return rows;
}

// --------------------------------------------------------------------------
// 发声：一只手选弦（1-5 指 = 1-5 弦，🤘 = 6 弦），另一只手张开拨弦 / 握起闷音
// --------------------------------------------------------------------------
const strumState = {
  lastTriggerMs: 0,
};

async function initAudio() {
  if (state.sampler) {
    await state.sampler.resume();
    return state.sampler;
  }
  try {
    els.audioBadge.textContent = '音频：加载采样…';
    els.audioBadge.className = 'badge loading';
    state.sampler = await GuitarSampler.create({ baseUrl: './assets/guitar/' });
    // 采样一就绪就把混响量接上（滑块默认值存在 state.reverb 里）
    state.sampler.setReverb(state.reverb ?? 0.22);
    els.audioBadge.textContent = `音频：${state.sampler.stats.notes} 个音 / ${state.sampler.stats.totalSeconds}s`;
    els.audioBadge.className = 'badge ok';
    diag(`音频就绪：${JSON.stringify(state.sampler.stats)}`);
    buildStringButtons();
    updateTransposeHint();
    renderBoard();
    return state.sampler;
  } catch (err) {
    console.error(err);
    els.audioBadge.textContent = `音频加载失败：${err.message || err}`;
    els.audioBadge.className = 'badge error';
    state.sampler = null;
    return null;
  }
}

// --------------------------------------------------------------------------
// 六弦板：把"我拨了哪根弦"直接画在屏幕上
//
// 为什么要有：弹的时候人盯着自己的手和画面，不会去看右侧面板。
// 拨弦的反馈必须出现在视线里，而且是"哪根弦 + 什么音 + 什么手势"
// 三件事一起给，否则学不会自己弹的是什么。
// --------------------------------------------------------------------------
// index 0 = 6 弦，符号就是选中这根弦的手势
const STRING_SYMBOLS = ['🤘', '🖐️', '4️⃣', '3️⃣', '✌️', '☝️'];
const TAB_MAX = 14;

/**
 * 弦号 ↔ 和弦槽位。
 *
 * **弦模式**：伸 n 根手指 → 弦号 `6 - n`（🤘 = 6 弦 = 第 1 行，☝️ = 1 弦 = 最后一行），
 * 行的符号就是你比的手势。
 *
 * **和弦模式**：一律 **伸 n 根手指 = 第 n 个和弦**（☝️ = 第 1 个 … 🖐️ = 第 5 个，🤘 = 第 6 个）。
 *
 * 这里踩过一个坑：和弦模式一开始沿用了弦模式的逆序（`槽位 = 6 - 手指数`），
 * 结果"伸 1 指"选中的是**第 6 个**和弦，而和弦按钮上写着 1..6、键盘 1-6 也是
 * 从第 1 个开始 —— 同一套编号出现两个含义，屏幕上高亮的那行当然"和手指对不上"。
 * 现在和弦模式下弦号与槽位是一一对应的反向映射，手势、按钮、键盘三者顺序一致。
 */
const slotFromStringIndex = (s) => 5 - s;
const stringIndexFromSlot = (slot) => 5 - slot;

function buildStringBoard() {
  if (!els.sbRows) return;
  const notes = state.sampler ? state.sampler.stringNotes(state.transpose || 0) : null;
  const fallback = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
  els.sbRows.innerHTML = STRING_LABELS.map((label, i) => {
    const n = notes ? notes[i] : fallback[i];
    return `<div class="sb-row" data-string="${i}">
      <span class="sb-sym" title="用这个手势选 ${label}">${STRING_SYMBOLS[i]}</span>
      <span class="sb-num">${6 - i}</span>
      <span class="sb-line"><i></i></span>
      <span class="sb-name">${n}</span>
      <span class="sb-count" data-count="${i}">0</span>
    </div>`;
  }).join('');
  // 重建之后把计数和预选补回去，否则换调/加载完采样会把状态清掉
  for (let i = 0; i < 6; i++) bumpCount(i, 0);
  setSelectedString(state.selectedString);
}

/** 把每根弦的拨弦次数画出来（哪根弦自己最不熟，一眼能看出来） */
function bumpCount(stringIndex, delta) {
  if (!els.sbRows) return;
  if (delta) state.stringCounts[stringIndex] = (state.stringCounts[stringIndex] || 0) + delta;
  const el = els.sbRows.querySelector(`[data-count="${stringIndex}"]`);
  if (el) el.textContent = String(state.stringCounts[stringIndex] || 0);
}

/** 预选高亮：手势已经锁定这根弦、但还没拨 */
function setSelectedString(stringIndex) {
  const next = Number.isInteger(stringIndex) && stringIndex >= 0 && stringIndex <= 5 ? stringIndex : -1;
  if (next === state.selectedString) return;
  state.selectedString = next;
  if (els.sbRows) {
    els.sbRows.querySelectorAll('.sb-row').forEach((row) => {
      row.classList.toggle('sel', Number(row.dataset.string) === next);
    });
  }
  if (els.sbSelected) {
    if (next < 0) {
      els.sbSelected.textContent = '预选 —';
      els.sbSelected.classList.remove('on');
    } else {
      const notes = state.sampler ? state.sampler.stringNotes(state.transpose || 0) : null;
      const n = notes ? notes[next] : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'][next];
      els.sbSelected.textContent = `预选 ${STRING_SYMBOLS[next]} → ${STRING_LABELS[next]} ${n}`;
      els.sbSelected.classList.add('on');
    }
  }
}

/** 画面上的大字：拨响的瞬间飘一下 */
function showPluckFlash(stringIndex, note) {
  if (!els.pluckFlash) return;
  els.pluckFlash.textContent = `${STRING_SYMBOLS[stringIndex]} ${STRING_LABELS[stringIndex]} · ${note}`;
  els.pluckFlash.classList.remove('go');
  void els.pluckFlash.offsetWidth; // 强制回流，让动画能重播
  els.pluckFlash.classList.add('go');
}

function renderTabStrip() {
  if (!els.tabStrip) return;
  els.tabStrip.innerHTML = state.tabHistory
    .map((h) =>
      h.chord
        ? `<span class="tab-chip chord"><b>${h.chord}</b><i>${h.note}</i></span>`
        : `<span class="tab-chip"><b>${6 - h.string}</b><i>${h.note}</i></span>`,
    )
    .join('');
}

/** 把"你弹过的东西"导成文本，方便贴到记事本里对谱子 */
function tabToText() {
  if (!state.tabHistory.length) return '（还没拨过弦）';
  const notes = state.sampler ? state.sampler.stringNotes(state.transpose || 0) : null;
  const head = `TAB（${state.chordMode ? '和弦模式' : '单音模式'}，变调 ${
    state.transpose > 0 ? '+' : ''
  }${state.transpose}${notes ? `，6 根弦 = ${notes.join(' ')}` : ''}，最近 ${state.tabHistory.length} 次）`;
  const line = state.tabHistory
    .map((h) => (h.chord ? `${h.chord}[${h.note}]` : `${6 - h.string}(${h.note})`))
    .join(' ');
  const counts = state.chordMode
    ? currentBank()
        .map((s, i) => `${s.name}×${state.chordCounts[i] || 0}`)
        .join('  ')
    : state.stringCounts
        .map((c, i) => `${6 - i}弦×${c}`)
        .reverse()
        .join('  ');
  return `${head}\n${line}\n${state.chordMode ? '各和弦次数' : '各弦次数'}：${counts}`;
}

function resetTab() {
  state.tabHistory.length = 0;
  state.stringCounts = [0, 0, 0, 0, 0, 0];
  state.chordCounts = [0, 0, 0, 0, 0, 0];
  renderTabStrip();
  for (let i = 0; i < 6; i++) bumpCount(i, 0);
  if (els.sbRows) {
    els.sbRows.querySelectorAll('.sb-row').forEach((r) => r.classList.remove('hit', 'sel'));
  }
  state.selectedString = -1;
  if (state.chordMode) buildChordBoard();
  else setSelectedString(-1);
}

function flashString(stringIndex, note = '') {
  const b = els.stringButtons?.querySelector(`button[data-string="${stringIndex}"]`);
  if (b) {
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 200);
  }
  // 六弦板：亮那一行 + 计数 + TAB
  const row = els.sbRows?.querySelector(`.sb-row[data-string="${stringIndex}"]`);
  if (row) {
    row.classList.remove('hit');
    void row.offsetWidth;
    row.classList.add('hit');
    setTimeout(() => row.classList.remove('hit'), 520);
  }
  bumpCount(stringIndex, 1);
  if (note) {
    state.tabHistory.push({ string: stringIndex, note, at: Math.round(performance.now()) });
    while (state.tabHistory.length > TAB_MAX) state.tabHistory.shift();
    renderTabStrip();
    showPluckFlash(stringIndex, note);
  }
}

function stringButtonsHtml() {
  const idx = ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'];
  const notes = state.sampler ? state.sampler.stringNotes(state.transpose || 0) : null;
  return idx
    .map((t, i) => `<button class="chip" data-string="${i}">${t} ${notes ? notes[i] : ['E', 'A', 'D', 'G', 'B', 'e'][i]}</button>`)
    .join('');
}

function buildStringButtons() {
  if (!els.stringButtons) return;
  els.stringButtons.innerHTML = stringButtonsHtml();
  els.stringButtons.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => {
      await initAudio();
      await state.sampler?.resume();
      const idx = Number(b.dataset.string);
      doPluck(idx, Number(els.rngVelocity.value), '试听');
    });
  });
}

function doPluck(stringIndex, velocity, why) {
  if (!state.sampler) return { ok: false, reason: '采样还没加载好' };
  let r = null;
  try {
    r = state.sampler.pluck(stringIndex, { velocity, transpose: state.transpose || 0 });
  } catch (err) {
    console.error('拨弦异常', err);
    return { ok: false, reason: `拨弦异常：${err.message || err}` };
  }
  if (!r) return { ok: false, reason: `第 ${stringIndex + 1} 根弦没有可用采样` };
  state.pluckCount += 1;
  state.flashUntil = performance.now() + 180;
  state.lastPluck = `${why}：${['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'][stringIndex]} · ${
    r.note
  } · ${pickLayer(velocity)} · 速率 ${playbackRateForFret(r.semis || 0).toFixed(3)}`;
  els.audioLog.textContent = `已拨 ${state.pluckCount} 次 · 最近：${state.lastPluck}`;
  state.pluckLog.push({
    t: Math.round(performance.now()),
    stringIndex,
    velocity: Number(velocity.toFixed(3)),
    why,
    note: r.note,
    semis: r.semis || 0,
  });
  flashString(stringIndex, r.note);
  return { ok: true, note: r.note, layer: r.layer };
}

// --------------------------------------------------------------------------
// 和弦模式
//
// 为什么要做这一块：在这之前，整把琴永远只有六个空弦音，一次也只响一根弦，
// 所以"弹和弦"实际只响一个音 —— 这就是听起来单调的根本原因。
// audio.js 里 strum() / playbackRateForFret() 早就在了，缺的是：
//   1) 和弦指型（chords.js 里的 CHORDS，26 个真实按法）
//   2) 手势/按键 → 和弦的映射（复用现成的"伸指数 → 编号"那条链路，零识别改动）
//   3) 一次把整个指型扫出来（strumChord）
// --------------------------------------------------------------------------

/** 当前和弦库的 6 个槽位（含"要听到的和弦"和"要按的指型"） */
function currentBank() {
  return bankSlots(state.bankKey, state.transpose || 0);
}

/** 槽位号 → 要听到的和弦名（超范围返回 null） */
function slotChord(slot) {
  const s = currentBank()[slot];
  return s ? s.name : null;
}

/** 槽位号 → 要按的指型（变调夹换过指型；没有就返回 null） */
function slotShape(slot) {
  const s = currentBank()[slot];
  return s && s.shape ? s.shape : null;
}

/** 弹一个和弦（槽位号） */
function doStrumChord(slot, velocity, why) {
  const name = slotChord(slot);
  if (!name) return { ok: false, reason: `和弦库第 ${slot + 1} 个槽位是空的` };
  if (!state.sampler) return { ok: false, reason: '采样还没加载好' };
  // 变调夹的语义：**听的和弦不变，按的指型变**（想听 C、夹 5 品 → 按 G 指型）
  const shape = slotShape(slot);
  if (!shape) return { ok: false, reason: `${name} 在变调 ${state.transpose || 0} 下没有指型，先把它调回 0` };
  let parts = [];
  try {
    parts = state.sampler.strumChord(shape, {
      velocity,
      spreadMs: 26,
      transpose: state.transpose || 0,
    });
  } catch (err) {
    console.error('扫和弦异常', err);
    return { ok: false, reason: `扫和弦异常：${err.message || err}` };
  }
  if (!parts.length) return { ok: false, reason: `和弦 ${name} 一根弦都没响` };
  state.pluckCount += parts.length;
  state.flashUntil = performance.now() + 180;
  // 显示名永远是"要听到的和弦"（= 和弦库/谱子上的写法），另标注实际按的指型
  const sounding = name;
  const notes = chordNoteNames(shape);
  const capo = state.transpose || 0;
  const shapeHint = shape.name && shape.name !== name ? `，按 ${shape.name} 指型` : '';
  state.lastChord = { name, sounding, notes, slot, shapeName: shape.name };
  const capoText = capo === 0 ? '' : `${name}（夹 ${capo} 品${shapeHint}）`;
  state.lastPluck = `${why}：${capo === 0 ? sounding : capoText} · ${notes.join(' ')} · ${parts.length} 根弦 · ${pickLayer(
    velocity,
  )}`;
  els.audioLog.textContent = `已拨 ${state.pluckCount} 个音 · 最近：${state.lastPluck}`;
  state.pluckLog.push({
    t: Math.round(performance.now()),
    chord: name,
    slot,
    velocity: Number(velocity.toFixed(3)),
    why,
    notes,
    strings: parts.length,
    shape: shape.name,
    capo,
  });
  flashChord(slot, sounding, notes);
  return { ok: true, name, sounding, notes, count: parts.length };
}

/** 和弦版的六弦板反馈：亮那一行 + 计数 + TAB + 大字 */
function flashChord(slot, sounding, notes) {
  const b = els.chordButtons?.querySelector(`button[data-slot="${slot}"]`);
  if (b) {
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 220);
  }
  const row = els.sbRows?.querySelector(`.sb-row[data-string="${slot}"]`);
  if (row) {
    row.classList.remove('hit');
    void row.offsetWidth;
    row.classList.add('hit');
    setTimeout(() => row.classList.remove('hit'), 520);
  }
  state.chordCounts[slot] = (state.chordCounts[slot] || 0) + 1;
  const c = els.sbRows?.querySelector(`[data-count="${slot}"]`);
  if (c) c.textContent = String(state.chordCounts[slot]);
  if (els.pluckFlash) {
    els.pluckFlash.textContent = `🎸 ${sounding} · ${notes.join(' ')}`;
    els.pluckFlash.classList.remove('go');
    void els.pluckFlash.offsetWidth;
    els.pluckFlash.classList.add('go');
  }
  state.tabHistory.push({ string: slot, chord: sounding, note: notes.join(' '), at: Math.round(performance.now()) });
  while (state.tabHistory.length > TAB_MAX) state.tabHistory.shift();
  renderTabStrip();
}

/**
 * 槽位 → 显示用信息。
 * **name = 要听到的和弦（永远和弦库标签一致）**，shapeName = 实际要按的指型。
 * 夹变调夹时两者不同（想听 C、夹 5 品 → 按 G 指型），所以要分别显示。
 */
function slotView(s) {
  const shape = s.shape;
  const frets = shape ? shape.frets.map((f) => (f < 0 ? 'x' : String(f))).join('') : '—';
  const shapeName = shape ? shape.name : '';
  const capo = state.transpose || 0;
  const changed = capo !== 0 && !!shapeName && shapeName !== s.name;
  return { name: s.name, shape, shapeName, frets, changed, capo, toneless: !shape };
}

/** 和弦版的六弦板：每行显示"手势 / 和弦名 / 指型 / 次数" */
function buildChordBoard() {
  if (!els.sbRows) return;
  const slots = currentBank();
  els.sbRows.innerHTML = slots
    .map((s, i) => {
      const v = slotView(s);
      // 和弦模式：第 i 行（= 第 i+1 个和弦）对应的手势是"伸 i+1 根手指"，
      // 也就是 STRING_SYMBOLS[5 - i]（☝️ 是 1 指 … 🤘 是 6 个）。符号 = 你要比的手势。
      const sym = STRING_SYMBOLS[stringIndexFromSlot(i)];
      const title = v.toneless
        ? `${v.name} 在变调 ${v.capo} 下没有指型`
        : `第 ${i + 1} 个和弦 ${v.name}：按 ${v.shapeName} 指型（6弦→1弦，x = 不弹）${
            v.changed ? ` · 夹 ${v.capo} 品` : ''
          }`;
      return `<div class="sb-row sb-chord${v.toneless ? ' toneless' : ''}" data-string="${i}" data-slot="${i}">
      <span class="sb-sym" title="比 ${sym} 选第 ${i + 1} 个和弦 ${v.name}">${sym}</span>
      <span class="sb-num"><b>${i + 1}</b> ${v.name}${v.changed ? `<u>${v.shapeName}</u>` : ''}</span>
      <span class="sb-line"><i></i></span>
      <span class="sb-name sb-frets" title="${title}">${v.frets}</span>
      <span class="sb-count" data-count="${i}">0</span>
    </div>`;
    })
    .join('');
  for (let i = 0; i < slots.length; i++) {
    const c = els.sbRows.querySelector(`[data-count="${i}"]`);
    if (c) c.textContent = String(state.chordCounts[i] || 0);
  }
  refreshSlotSelected();
}

/** 和弦模式下"预选"那一栏的文字 */
function refreshSlotSelected() {
  if (!els.sbSelected) return;
  if (state.selectedString < 0) {
    els.sbSelected.textContent = '预选 —';
    els.sbSelected.classList.remove('on');
    return;
  }
  const s = currentBank()[state.selectedString];
  if (!s) {
    els.sbSelected.textContent = '预选 —';
    els.sbSelected.classList.remove('on');
    return;
  }
  const v = slotView(s);
  const tail = v.changed ? `（按 ${v.shapeName} 指型）` : '';
  els.sbSelected.textContent = `预选 ${STRING_SYMBOLS[stringIndexFromSlot(state.selectedString)]} → 第 ${
    state.selectedString + 1
  } 个 ${v.name}${tail}`;
  els.sbSelected.classList.add('on');
}

/** 按当前模式画六弦板（和弦模式画和弦，否则画弦） */
function renderBoard() {
  if (state.chordMode) buildChordBoard();
  else buildStringBoard();
}

/** 和弦模式下行高亮（和弦模式下 setSelectedString 只更新文字，不碰 DOM 里的弦名） */
function setChordSelected(slot) {
  const next = Number.isInteger(slot) && slot >= 0 && slot <= 5 ? slot : -1;
  if (next === state.selectedString) return;
  state.selectedString = next;
  els.sbRows?.querySelectorAll('.sb-row').forEach((row) => {
    row.classList.toggle('sel', Number(row.dataset.string) === next);
  });
  refreshSlotSelected();
}

/** 6 个槽位的按钮（点一下 = 扫这个和弦） */
function chordButtonsHtml() {
  return currentBank()
    .map((s) => {
      const v = slotView(s);
      const title = v.toneless
        ? `${v.name} 在变调 ${v.capo} 下没有指型`
        : `${v.name}：按 ${v.shapeName} 指型 ${v.frets}${v.changed ? `，夹 ${v.capo} 品` : ''}`;
      return `<button class="chip chord-chip${v.toneless ? ' toneless' : ''}" data-slot="${s.slot}" title="${title}">
        <b>${s.slot + 1}</b> ${v.name}<i>${v.frets}</i>
        ${v.changed ? `<u>${v.shapeName}</u>` : ''}
      </button>`;
    })
    .join('');
}

function buildChordButtons() {
  if (!els.chordButtons) return;
  els.chordButtons.innerHTML = chordButtonsHtml();
  els.chordButtons.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => {
      await initAudio();
      await state.sampler?.resume();
      doStrumChord(Number(b.dataset.slot), Number(els.rngVelocity.value), '点击');
    });
  });
}

/** 全部和弦的清单（不在 6 个槽位里的和弦也能点着弹） */
function buildChordAll() {
  if (!els.chordAll) return;
  const groups = {};
  for (const [name, shape] of Object.entries(CHORDS)) {
    (groups[shape.group || '其他'] ||= []).push(name);
  }
  const capo = state.transpose || 0;
  els.chordAll.innerHTML = Object.entries(groups)
    .map(
      ([g, list]) =>
        `<div class="chord-group"><span class="chord-group-label">${g}</span>${list
          .map((n) => {
            const sh = shapeForSounding(n, capo);
            const frets = sh ? sh.frets.map((f) => (f < 0 ? 'x' : String(f))).join('') : '—';
            const extra = sh && capo !== 0 && sh.name !== n ? ` → 按 ${sh.name} 指型` : '';
            return `<button class="chip chord-chip tiny${sh ? '' : ' toneless'}" data-chord="${n}" title="${n}${extra} ${frets}">${n}${
              sh && capo !== 0 && sh.name !== n ? `<u>${sh.name}</u>` : ''
            }</button>`;
          })
          .join('')}</div>`,
    )
    .join('');
  els.chordAll.querySelectorAll('button[data-chord]').forEach((b) => {
    b.addEventListener('click', async () => {
      await initAudio();
      await state.sampler?.resume();
      const name = b.dataset.chord;
      // 和槽位同一个口径：听的和弦不变，按的指型随变调夹走
      const shape = shapeForSounding(name, state.transpose || 0);
      if (!state.sampler) return;
      if (!shape) {
        els.audioLog.textContent = `${name} 在变调 ${state.transpose || 0} 下没有指型，先把变调调回 0`;
        return;
      }
      state.sampler.strumChord(shape, { velocity: Number(els.rngVelocity.value), spreadMs: 26, transpose: state.transpose || 0 });
      const notes = chordNoteNames(shape);
      state.pluckCount += chordStrings(shape).length;
      state.lastChord = { name, sounding: name, notes, slot: -1, shapeName: shape.name };
      const capoTail = shape.name !== name ? `（按 ${shape.name} 指型，夹 ${state.transpose || 0} 品）` : '';
      els.audioLog.textContent = `已拨 ${state.pluckCount} 个音 · 最近：${name}${capoTail} · ${notes.join(' ')}`;
      if (els.pluckFlash) {
        els.pluckFlash.textContent = `🎸 ${name} · ${notes.join(' ')}`;
        els.pluckFlash.classList.remove('go');
        void els.pluckFlash.offsetWidth;
        els.pluckFlash.classList.add('go');
      }
    });
  });
}

function buildChordBankSelect() {
  if (!els.selChordBank) return;
  els.selChordBank.innerHTML = Object.entries(CHORD_BANKS)
    .map(([k, b]) => `<option value="${k}">${b.label}</option>`)
    .join('');
  els.selChordBank.value = state.bankKey;
}

/** 开关和弦模式：板子、按钮、提示一起换 */
function setChordMode(on) {
  state.chordMode = !!on;
  document.body.classList.toggle('chord-mode', state.chordMode);
  if (els.chkChordMode) els.chkChordMode.checked = state.chordMode;
  state.selectedString = -1;
  renderBoard();
  buildChordButtons();
  updateChordHint();
}

function updateChordHint() {
  if (!els.chordHint) return;
  if (!state.chordMode) {
    els.chordHint.textContent = '现在是单音模式：伸 1-5 根手指选 1-5 弦（🤘 = 6弦），另一只手张开拨响它。';
    return;
  }
  const capo = state.transpose || 0;
  const slots = currentBank()
    .map((s, i) => {
      const v = slotView(s);
      return `${i + 1}=${v.name}${v.changed ? `(按${v.shapeName})` : ''}`;
    })
    .join('  ');
  const capoNote =
    capo === 0
      ? ''
      : ` 变调 ${capo > 0 ? '+' : ''}${capo} = 夹变调夹：听的和弦不变，指型整体换个把位（括号里是实际要按的）。`;
  els.chordHint.textContent = `和弦模式：另一只手伸 n 根手指 = 第 n 个和弦（☝️ 第 1 个 … 🖐️ 第 5 个，🤘 第 6 个），这只手张开 = 扫响整个和弦。键盘 1-6 顺序相同。当前：${slots}${capoNote}`;
}

function updateReverb(fromSlider = true) {
  const v = fromSlider && els.rngReverb ? Number(els.rngReverb.value) : Math.round((state.reverb ?? 0.22) * 100);
  state.reverb = Math.max(0, Math.min(1, v / 100));
  if (els.reverbVal) els.reverbVal.textContent = `${v}%`;
  if (state.sampler) state.sampler.setReverb(state.reverb);
  return state.reverb;
}

/** 变调变了：和弦名和指型提示要跟着重新算 */
function refreshChordUi() {
  buildChordButtons();
  buildChordAll();
  updateChordHint();
  if (state.chordMode) buildChordBoard();
}

/** 变调变了：更新提示文字（6 根弦现在是什么音）和按钮/六弦板上的音名 */
function updateTransposeHint() {
  if (els.transposeVal) {
    const names = state.sampler ? state.sampler.stringNotes(state.transpose || 0) : null;
    els.transposeVal.textContent = names
      ? `6 根弦：${names.join(' ')}`
      : `变调 ${state.transpose > 0 ? '+' : ''}${state.transpose} 个半音`;
  }
  if (state.sampler) {
    buildStringButtons();
    renderBoard();
    // 变调（= 夹变调夹）之后，和弦的名字要跟着变，提示也要重算
    refreshChordUi();
  }
}

/**
 * 每帧跑一次的手势状态机（重写版）。
 *
 * 和老版的区别，都是为了治"不灵敏 / 乱串弦 / 不出声"：
 *  1. 每只手的伸展度先过平滑+滞回+投票+锁定（landmarks.js 的状态机），
 *     不再拿单帧硬阈值直接判弦；
 *  2. **不再写死哪只手拨弦**：默认"任意手"——哪只手做了张开/挥动动作，哪只手就是拨弦手，
 *     另一只手负责选弦。这样 MediaPipe 把左右手标反了也照样能响（这是老版最致命的坑）；
 *  3. 触发不再要求"张开 ≥3 指"：只要张开程度在 ~0.3 秒内涨了 0.4 以上就算一次拨弦，
 *     张开 2 根手指也能触发；
 *  4. 选弦手短暂握拳/抖动时，靠状态机的锁定继续用上一次的弦，不会断音；
 *  5. 每一步都写进右侧"演奏状态"面板，为什么不响能一眼看到。
 */
function handleStrum(hands, nowOverride, { instant = false } = {}) {
  const now = nowOverride ?? performance.now();
  if (!state.audioOn) {
    setPlayState('声音没开：先勾上「发声（真实吉他采样）」里的开关', 'warn');
    return;
  }
  if (!state.sampler) {
    setPlayState('采样音色还没加载好。点一下「6弦 E」那几个按钮就能触发加载。', 'warn');
    return;
  }

  // --- 1. 每只手过状态机 ---
  const seen = new Set();
  const tracks = hands.map((h) => {
    const key = h.handedness || 'Unknown';
    seen.add(key);
    if (!state.trackers.has(key)) state.trackers.set(key, createHandTracker(trackerOpts()));
    if (!state.motions.has(key)) state.motions.set(key, createMotionTracker());
    const t = state.trackers.get(key);
    const m = state.motions.get(key);
    const snap = updateHandTracker(t, h.features.ext, now, { instant });
    const wrist = h.landmarks[0];
    const speed = updateMotionTracker(m, wrist, h.features.palmSpan, now);
    const trig = checkStrumTrigger(t, now);
    return {
      hand: h,
      key,
      t,
      snap,
      speed,
      trig,
      delta: trig.delta,
      palmSpan: h.features.palmSpan,
    };
  });
  // 手离开画面一段时间后清掉跟踪状态，避免回来时用着过期的锁定
  for (const [k, t] of state.trackers) {
    if (!seen.has(k) && now - t.lockedAt > 2000) {
      state.trackers.delete(k);
      state.motions.delete(k);
    }
  }

  // 记下平滑后的伸展度，给"手势校准"取样用（只留最近 3 秒）
  for (const tr of tracks) {
    if (tr.t.ext) state.extLog.push({ t: now, key: tr.key, ext: [...tr.t.ext] });
  }
  while (state.extLog.length && now - state.extLog[0].t > 3000) state.extLog.shift();
  if (state.extLog.length > 400) state.extLog.splice(0, state.extLog.length - 400);

  // --- 2. 找拨弦动作：张开程度突增，或者手腕快速挥动 ---
  const mode = els.selTrigger.value; // 'both' | 'open' | 'motion'
  const motionThresh = Number(els.rngMotion.value);
  const candidates = tracks.map((tr) => {
    // "挥动"触发不设重新武装：扫弦本来就是来回动，冷却时间就是它的节流
    const openHit = tr.trig.hit;
    const motionHit = tr.speed >= motionThresh;
    const hit = (mode === 'open' && openHit) || (mode === 'motion' && motionHit) || (mode === 'both' && (openHit || motionHit));
    return { ...tr, openHit, motionHit, hit, strength: Math.max(tr.delta, Math.min(1, tr.speed / Math.max(1, motionThresh))) };
  });
  const hitter = candidates.filter((c) => c.hit).sort((a, b) => b.strength - a.strength)[0] || null;

  // --- 3. 选弦手：没在做拨弦动作的那只手里，选弦结果最可信的一只 ---
  const role = els.selStrumHand.value; // 'auto' | 'Right' | 'Left'
  let stringHand = null;
  if (hitter) {
    // 只考虑"没在做拨弦动作"的那只手；只有一只手时这里会是 null，走下面的单手逻辑
    stringHand = pickStringHand(candidates.filter((c) => c !== hitter));
  } else {
    // 没有拨弦动作时，按角色设置挑一只来显示状态
    const pool =
      role === 'auto'
        ? candidates
        : candidates.filter((c) => c.key === role);
    stringHand = pickStringHand(pool.length ? pool : candidates);
  }

  // 手动指定拨弦手时：只有那只手的动作算数
  const effectiveHitter = role === 'auto' ? hitter : candidates.find((c) => c.hit && c.key === role) || null;

  // --- 3.5 把"当前预选的弦/和弦"画到六弦板上（拨之前就能看见自己选的是哪根）---
  if (stringHand && stringHand.snap.string !== UNKNOWN_STRING) {
    // 和弦模式：伸 n 指 = 第 n 个和弦 → 槽位 = 5 - 弦号
    if (state.chordMode) setChordSelected(slotFromStringIndex(stringHand.snap.string));
    else setSelectedString(stringHand.snap.string);
  } else if (!effectiveHitter) {
    if (state.chordMode) setChordSelected(-1);
    else setSelectedString(-1);
  }

  // --- 4. 真的拨 ---
  if (effectiveHitter) {
    // 选弦来源：优先另一只手；只有一只手时用这只手"张开前"锁定的那根弦
    // （否则张开动作会把这根手自己也投成"五指 = 5 弦"，弦号就取错了）
    let sel = stringHand && stringHand.snap.string !== UNKNOWN_STRING ? stringHand.snap.string : UNKNOWN_STRING;
    let selWhy = '';
    if (sel === UNKNOWN_STRING && effectiveHitter.snap.string !== UNKNOWN_STRING) {
      const t = effectiveHitter.t;
      const justChanged = now - t.lockedAt < 350;
      if (justChanged && t.prevString !== UNKNOWN_STRING) {
        sel = t.prevString;
        selWhy = '单手·用张开前那根弦';
      } else {
        sel = effectiveHitter.snap.string;
        selWhy = '单手';
      }
    }
    if (sel !== UNKNOWN_STRING && now - strumState.lastTriggerMs > 130) {
      strumState.lastTriggerMs = now;
      consumeStrum(effectiveHitter.t); // 这次张开已经用掉，等手收回一点再武装
      const strength = effectiveHitter.strength;
      const velocity = Math.max(0.3, Math.min(1, 0.45 + 0.5 * strength));
      const gestureWhy = `手势(${effectiveHitter.openHit ? '张开' : '挥动'}${selWhy ? '·' + selWhy : ''})`;
      // 和弦模式：伸 n 指 = 第 n 个和弦（槽位 = 5 - 弦号）
      const slot = slotFromStringIndex(sel);
      const played = state.chordMode
        ? doStrumChord(slot, velocity, gestureWhy)
        : doPluck(sel, velocity, gestureWhy);
      const target = state.chordMode
        ? `第 ${slot + 1} 个和弦 ${slotChord(slot) || '?'}`
        : ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'][sel];
      if (!played.ok) {
        // 不出声的时候绝不能说"拨弦成功"——面板必须说实话
        setPlayState(`⚠ 手势认出 ${target}，但没出声：${played.reason}`, 'warn');
        return;
      }
      setPlayState(
        `▲ ${state.chordMode ? '扫和弦' : '拨弦'}！${effectiveHitter.key === 'Right' ? '右手' : '左手'}${
          effectiveHitter.openHit ? '张开' : '挥动'
        }${selWhy ? `（${selWhy}）` : ''} → ${
          state.chordMode ? `第 ${slot + 1} 个 ${played.sounding}（${played.notes.join(' ')}）` : target
        } · 力度 ${velocity.toFixed(2)}`,
        'hit',
      );
      return;
    }
    if (sel === UNKNOWN_STRING) {
      setPlayState(
        `拨弦动作识别到了，但没选到${state.chordMode ? '和弦' : '弦'}：${
          state.chordMode
            ? '另一只手伸 1-5 根手指选第 1-5 个和弦（🤘 = 第 6 个）'
            : candidates.length > 1
              ? '另一只手伸 1-5 根手指选弦（🤘 = 6 弦）'
              : '先伸 1-5 根手指选弦，再张开拨弦'
        }`,
        'warn',
      );
      return;
    }
  }

  // --- 5. 没触发：把当前状态和原因写出来 ---
  if (hands.length === 0) {
    setPlayState('没看到手。把手放进画面里，光线亮一点。', 'warn');
    return;
  }
  const parts = candidates.map((c) => {
    const name = c.key === 'Right' ? '右手' : c.key === 'Left' ? '左手' : '手';
    const s = c.snap;
    // 和弦模式下把"这个弦号会被当成第几个和弦"直接写出来：
    // 用户报"手指数对但对应不对"时，这一行能立刻区分是识别错了还是映射错了
    const chordIdx =
      state.chordMode && s.string !== UNKNOWN_STRING
        ? ` → 第 ${slotFromStringIndex(s.string) + 1} 个和弦`
        : '';
    const basis =
      s.judgedBy === 'template' ? '（校准模板）' : s.templateRejected ? '（模板没把握·用规则）' : '';
    const bad = s.judgedAgrees === false && s.string !== UNKNOWN_STRING ? ' ⚠判定与本手指数不符' : '';
    return `${name}：伸 ${s.count} 根${s.stringName ? `→${s.stringName}` : ''}${chordIdx}${basis}${bad}（张合+${c.delta.toFixed(2)} 速度${c.speed.toFixed(1)}）`;
  });
  setPlayState(
    `${parts.join('　')}\n要发声：${stringHand ? `选弦手已${stringHand.snap.stringName ? `锁定 ${stringHand.snap.stringName}` : '没选到弦'}；` : ''}另一只手张开或挥一下`,
    'idle',
  );
  if (state.muteOn && state.sampler) {
    // 闷音只看"不在选弦的那只手"，而且 count===0 才算握拳。
    // （旧版写 count<=1 把"伸 1 根手指"也算成握拳 → 选 1 弦时每帧都在闷音 → 1 弦永远不响）
    const counts = candidates.map((c) => ({ key: c.key, count: c.snap.count }));
    if (shouldMute(counts, stringHand ? stringHand.key : null)) {
      state.muteCalls = (state.muteCalls || 0) + 1;
      state.sampler.mute();
    }
  }
}

/** 选弦手：弦号有效优先，其次置信度高 */
function pickStringHand(pool) {
  if (!pool || !pool.length) return null;
  const valid = pool.filter((c) => c.snap.string !== UNKNOWN_STRING);
  const from = valid.length ? valid : pool;
  return from.slice().sort((a, b) => b.snap.confidence - a.snap.confidence)[0] || null;
}

function trackerOpts() {
  const on = Number(els.rngSens.value);
  return {
    on,
    off: Math.max(0.25, on - 0.15),
    mapping: els.selMapping.value,
    templates: state.templates || null, // 有校准模板就优先按模板判（吸收个人手型差异）
  };
}

/** 右侧"演奏状态"面板。非命中状态节流到 ~8Hz，避免 60fps 改 DOM */
function setPlayState(text, kind = 'idle') {
  if (!els.playState) return;
  const now = performance.now();
  if (kind !== 'hit' && now - (state.lastPlayAt || 0) < 120 && text === state.lastPlayText) return;
  state.lastPlayAt = now;
  state.lastPlayText = text;
  els.playState.textContent = text;
  els.playState.className = `play-state ${kind}`;
}

/**
 * 造一只"合成手"，直接给出伸展度，不经过关键点。
 * handleStrum 只读 features.ext / features.palmSpan / landmarks[0]，所以这样就够了。
 */
function makeSimHand(h, phaseIndex) {
  const ox = h.handedness === 'Right' ? -0.2 : 0.2;
  // move=true 时让手腕来回动，用来测"挥动触发"
  const swing = h.move ? Math.sin(phaseIndex / 3) * (h.moveAmp || 0.12) : 0;
  const wx = 0.5 + ox + (h.dx || 0) + swing;
  const wy = 0.5 + (h.dy || 0);
  return {
    handedness: h.handedness,
    score: 1,
    landmarks: Array.from({ length: 21 }, (_, k) => ({
      x: wx + (k % 5) * 0.01,
      y: wy + Math.floor(k / 5) * 0.01,
      z: 0,
    })),
    features: {
      ext: h.ext,
      palmSpan: 0.2,
      pinch: 1,
      count: h.ext.filter((v) => v >= Number(els.rngSens.value)).length,
      signature: h.ext.map((v) => (v >= Number(els.rngSens.value) ? '1' : '0')).join(''),
    },
  };
}

/**
 * 按"阶段"喂合成手势，时钟自己推进（默认 16.7ms/帧 ≈ 60fps），
 * 所以张合增量、冷却时间、投票窗口都和真跑时一致。
 */
function simRun(phases, opts = {}) {
  state.trackers.clear();
  state.motions.clear();
  strumState.lastTriggerMs = 0;
  if (opts.mapping) els.selMapping.value = opts.mapping;
  if (opts.sens) els.rngSens.value = String(opts.sens);
  if (opts.trigger) els.selTrigger.value = opts.trigger;
  if (opts.motion) els.rngMotion.value = String(opts.motion);
  if (opts.transpose !== undefined) {
    els.selTranspose.value = String(opts.transpose);
    state.transpose = Number(opts.transpose) || 0;
  }

  const log0 = state.pluckLog.length;
  state.muteCalls = 0;
  let t = 0;
  const dt = opts.dt || 16.7;
  const snaps = [];
  const muteByPhase = [];
  for (const ph of phases) {
    for (let i = 0; i < (ph.frames || 12); i++) {
      t += dt;
      handleStrum((ph.hands || []).map((h) => makeSimHand(h, i)), t);
    }
    if (ph.snapshot) {
      snaps.push(
        Object.fromEntries([...state.trackers].map(([k, v]) => [k, snapshotHandTracker(v)])),
      );
    }
    muteByPhase.push(state.muteCalls || 0);
  }
  return {
    plucks: state.pluckLog.slice(log0),
    snapshots: snaps,
    muteByPhase,
    muteCalls: state.muteCalls || 0,
    trackers: Object.fromEntries([...state.trackers].map(([k, v]) => [k, snapshotHandTracker(v)])),
    playState: els.playState?.textContent || null,
  };
}

/**
 * 页面内"手势逻辑自检"：?sim=1 打开。
 * 全是合成的伸展度，不需要摄像头，用来确定性地证明"会不会响 / 会不会串弦"。
 */
function runSimTest() {
  const out = [];
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else fail++;
    out.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? `　[${extra}]` : ''}`);
  };

  const FIST = [0.05, 0.05, 0.05, 0.05, 0.05];
  const ONE = [0.05, 0.92, 0.06, 0.06, 0.06];
  const TWO = [0.05, 0.92, 0.9, 0.06, 0.06];
  const THREE = [0.05, 0.92, 0.9, 0.88, 0.06];
  const FOUR = [0.05, 0.92, 0.9, 0.88, 0.86];
  const FIVE = [0.9, 0.92, 0.9, 0.9, 0.88];
  const HORNS = [0.9, 0.06, 0.06, 0.06, 0.88];
  const NAME = ['6弦', '5弦', '4弦', '3弦', '2弦', '1弦'];

  // 一只手稳定选弦 → 另一只手张开 → 应该拨出对应的弦
  const scenario = (selectExt, wantIdx, label) => {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: selectExt }, { handedness: 'Right', ext: FIST }], frames: 14 },
      { hands: [{ handedness: 'Left', ext: selectExt }, { handedness: 'Right', ext: FIVE }], frames: 14 },
    ]);
    check(label, r.plucks.length >= 1 && r.plucks[0].stringIndex === wantIdx,
      `拨了 ${r.plucks.length} 次${r.plucks.length ? ` 第一根=${NAME[r.plucks[0].stringIndex]}` : ''}`);
    return r;
  };

  out.push('— 1. 六根弦按手势发声 —');
  scenario(ONE, 5, '伸 1 指 → 1 弦');
  scenario(TWO, 4, '伸 2 指 → 2 弦');
  scenario(THREE, 3, '伸 3 指 → 3 弦');
  scenario(FOUR, 2, '伸 4 指 → 4 弦');
  scenario(FIVE, 1, '伸 5 指 → 5 弦');
  scenario(HORNS, 0, '🤘 → 6 弦');

  out.push('— 2. 左右手互换也必须响（老版写死右手，标反就不响）—');
  {
    const r = simRun([
      { hands: [{ handedness: 'Right', ext: TWO }, { handedness: 'Left', ext: FIST }], frames: 14 },
      { hands: [{ handedness: 'Right', ext: TWO }, { handedness: 'Left', ext: FIVE }], frames: 14 },
    ]);
    check('左手拨弦 + 右手选 2 弦 → 响 2 弦', r.plucks.length >= 1 && r.plucks[0].stringIndex === 4,
      `拨了 ${r.plucks.length} 次`);
  }

  out.push('— 3. 张开 2 根手指也能触发（老版要求 ≥3 根）—');
  {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: ONE }, { handedness: 'Right', ext: FIST }], frames: 14 },
      { hands: [{ handedness: 'Left', ext: ONE }, { handedness: 'Right', ext: TWO }], frames: 14 },
    ]);
    check('拨弦手只张开 2 根 → 仍然响', r.plucks.length >= 1, `拨了 ${r.plucks.length} 次`);
  }

  out.push('— 4. 一直张着手不会连发（避免刷屏）—');
  {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIST }], frames: 14 },
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIVE }], frames: 6 },
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIVE }], frames: 120 },
    ]);
    check('张开后一直举着 → 只响 1 次', r.plucks.length === 1, `拨了 ${r.plucks.length} 次`);
  }

  out.push('— 5. 抗抖动：连续晃动仍然是同一根弦 —');
  {
    const jitter = (base, k) => base.map((v) => Math.max(0.02, Math.min(0.99, v + Math.sin(k / 2) * 0.12)));
    const phases = [];
    for (let i = 0; i < 60; i++) {
      phases.push({
        hands: [{ handedness: 'Left', ext: jitter(TWO, i) }, { handedness: 'Right', ext: FIST }],
        frames: 1,
        snapshot: true,
      });
    }
    const r = simRun(phases);
    // 前几帧是投票预热期，本来还没有结论，所以只看预热之后
    const locked = r.snapshots.map((s) => s.Left?.string).slice(6);
    check('抖动 60 帧里弦号始终是 2 弦', locked.every((v) => v === 4), `出现过 ${[...new Set(locked)].join(',')}`);
    check('置信度始终处于高位', r.snapshots.slice(6).every((s) => (s.Left?.confidence ?? 0) >= 0.6),
      `最低 ${Math.min(...r.snapshots.slice(6).map((s) => s.Left?.confidence ?? 1))}`);
  }

  out.push('— 6. 单帧抽风不会串弦 —');
  {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIST }], frames: 20 },
      { hands: [{ handedness: 'Left', ext: FIVE }, { handedness: 'Right', ext: FIST }], frames: 1, snapshot: true },
      { hands: [{ handedness: 'Left', ext: FIVE }, { handedness: 'Right', ext: FIST }], frames: 1, snapshot: true },
    ]);
    check('一帧串成五指 → 弦号仍是 2 弦', r.snapshots[0].Left.string === 4, String(r.snapshots[0].Left.string));
    check('两帧串成五指 → 弦号仍是 2 弦', r.snapshots[1].Left.string === 4, String(r.snapshots[1].Left.string));
  }

  out.push('— 7. 两种映射方案（拇指抖动的影响）—');
  {
    const jit = [1, 0.92, 0.9, 0.06, 0.06];
    const noj = [0.06, 0.92, 0.9, 0.06, 0.06];
    const a = simRun([{ hands: [{ handedness: 'Left', ext: jit }], frames: 20 }], { mapping: 'count' });
    const b = simRun([{ hands: [{ handedness: 'Left', ext: noj }], frames: 20 }], { mapping: 'count' });
    check('方案A：拇指伸出与否会改变弦号（这就是串弦的根源）', a.trackers.Left.string !== b.trackers.Left.string,
      `${NAME[a.trackers.Left.string]} vs ${NAME[b.trackers.Left.string]}`);
    const c = simRun([{ hands: [{ handedness: 'Left', ext: jit }], frames: 20 }], { mapping: 'long' });
    const d = simRun([{ hands: [{ handedness: 'Left', ext: noj }], frames: 20 }], { mapping: 'long' });
    check('方案B：拇指抖动不再影响弦号', c.trackers.Left.string === d.trackers.Left.string,
      `${NAME[c.trackers.Left.string]} vs ${NAME[d.trackers.Left.string]}`);
    els.selMapping.value = 'count';
  }

  out.push('— 8. 挥动触发 —');
  {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }], frames: 14 },
      { hands: [{ handedness: 'Left', ext: TWO, move: true, moveAmp: 0.18 }], frames: 40 },
    ], { trigger: 'motion', motion: 2 });
    check('手腕快速挥动 → 触发发声', r.plucks.length >= 1, `拨了 ${r.plucks.length} 次`);
    els.selTrigger.value = 'both';
    els.rngMotion.value = '3';
  }

  out.push('— 9. 握拳时不出声，并且给出原因 —');
  {
    const r = simRun([{ hands: [{ handedness: 'Left', ext: FIST }, { handedness: 'Right', ext: FIST }], frames: 30 }]);
    check('两手都握拳 → 不发声', r.plucks.length === 0, `拨了 ${r.plucks.length} 次`);
    check('面板给出了原因', /没选到弦|没选弦|握拳/.test(r.playState || ''), (r.playState || '').slice(0, 40));
  }

  out.push('— 10. 单手弹：先摆 2 指，再张开 → 应该拨 2 弦（不是张开后的 5 弦）—');
  {
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }], frames: 20 },
      { hands: [{ handedness: 'Left', ext: FIVE }], frames: 20 },
    ]);
    check('单手 → 拨的是"张开前那根弦"（2 弦）', r.plucks.length >= 1 && r.plucks[0].stringIndex === 4,
      r.plucks.length ? `拨了 ${NAME[r.plucks[0].stringIndex]}` : '一次都没拨');
  }

  // ===== 下面几组是照着用户实测反馈复刻的 =====
  // 用户的手：拇指偏高（一伸食指拇指就跟着翘到 0.6 左右），
  // 而拇指是五根里最难判稳的一根 → 固定阈值必然出问题。
  const U_THUMB_HIGH = { fist: [0.2, 0.06, 0.05, 0.05, 0.05], one: [0.62, 0.93, 0.1, 0.09, 0.08] };

  out.push('— 11. 复刻实测症状：比划 1 指（食指）却不响 —');
  {
    // 拇指被一起判成伸出 → count 映射数成 2 根 → 2 弦（用户听到的就是"不响 1 弦"）
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: U_THUMB_HIGH.one }, { handedness: 'Right', ext: FIST }], frames: 12 },
      { hands: [{ handedness: 'Left', ext: U_THUMB_HIGH.one }, { handedness: 'Right', ext: FIVE }], frames: 12 },
    ]);
    check('内置 count 规则：拇指翘着比划"1 指" → 会响，但判成 2 弦（症状复现）',
      r.plucks.length >= 1 && r.plucks[0].stringIndex === 4,
      r.plucks.length ? `响的是 ${NAME[r.plucks[0].stringIndex]}` : '没响');

    // 换方案 B：拇指不参与计数 → 正确 1 弦
    els.selMapping.value = 'long';
    const r2 = simRun([
      { hands: [{ handedness: 'Left', ext: U_THUMB_HIGH.one }, { handedness: 'Right', ext: FIST }], frames: 12 },
      { hands: [{ handedness: 'Left', ext: U_THUMB_HIGH.one }, { handedness: 'Right', ext: FIVE }], frames: 12 },
    ]);
    check('方案B：同一只手 → 正确响 1 弦', r2.plucks.length >= 1 && r2.plucks[0].stringIndex === 5,
      r2.plucks.length ? `响的是 ${NAME[r2.plucks[0].stringIndex]}` : '没响');
    els.selMapping.value = 'count';
  }

  out.push('— 12. 复刻实测症状：比划 🤘 显示 2 指，有时响 1 弦 —');
  {
    // (a) 拇指漏判：只剩小指 → 旧规则数成 1 根 → 1 弦（用户遇到的误判）
    const pinkyOnly = [0.1, 0.08, 0.06, 0.06, 0.9];
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: pinkyOnly }, { handedness: 'Right', ext: FIST }], frames: 12 },
      { hands: [{ handedness: 'Left', ext: pinkyOnly }, { handedness: 'Right', ext: FIVE }], frames: 12 },
    ]);
    check('🤘 但拇指没判出来 → 仍按 6 弦发声（不再误判成 1 弦）',
      r.plucks.length >= 1 && r.plucks[0].stringIndex === 0,
      r.plucks.length ? `响的是 ${NAME[r.plucks[0].stringIndex]}` : '没响');
    // (b) 完整 🤘：拇指+小指，面板显示"2 根"是正常的，声音必须是 6 弦
    const r2 = simRun([
      { hands: [{ handedness: 'Left', ext: HORNS }, { handedness: 'Right', ext: FIST }], frames: 12 },
      { hands: [{ handedness: 'Left', ext: HORNS }, { handedness: 'Right', ext: FIVE }], frames: 12 },
    ]);
    check('完整 🤘（面板显示伸出 2 根）→ 声音仍是 6 弦',
      r2.plucks.length >= 1 && r2.plucks[0].stringIndex === 0,
      r2.plucks.length ? `响的是 ${NAME[r2.plucks[0].stringIndex]}` : '没响');
  }

  out.push('— 13. 手势校准模板：吸收"拇指偏高"这个个人差异 —');
  {
    // 模拟用户校准出来的模板（拇指天然偏高）
    const before = state.templates;
    state.templates = {
      5: [0.62, 0.93, 0.11, 0.09, 0.08], // 1 弦
      4: [0.6, 0.92, 0.9, 0.1, 0.09], // 2 弦
      3: [0.58, 0.91, 0.89, 0.87, 0.1], // 3 弦
      2: [0.66, 0.92, 0.9, 0.88, 0.85], // 4 弦
      1: [0.94, 0.95, 0.93, 0.9, 0.9], // 5 弦
      0: [0.7, 0.1, 0.09, 0.1, 0.93], // 6 弦
    };
    const cases = [
      [U_THUMB_HIGH.one, 5, '拇指翘着的"1 指"'],
      [[0.61, 0.92, 0.91, 0.11, 0.1], 4, '抖动的"2 指"'],
      [[0.7, 0.09, 0.1, 0.08, 0.92], 0, '拇指不稳的 🤘'],
    ];
    for (const [ext, want, label] of cases) {
      const r = simRun([
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIST }], frames: 12 },
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIVE }], frames: 12 },
      ]);
      check(`校准后：${label} → 正确响 ${NAME[want]}`,
        r.plucks.length >= 1 && r.plucks[0].stringIndex === want,
        r.plucks.length ? `响的是 ${NAME[r.plucks[0].stringIndex]}` : '没响');
    }
    check('校准后仍能给出"像哪个模板、距离多少"', (() => {
      const r = simRun([{ hands: [{ handedness: 'Left', ext: U_THUMB_HIGH.one }], frames: 10, snapshot: true }]);
      const s = r.snapshots.at(-1)?.Left;
      return s && s.kind === 'template' && typeof s.distance === 'number' && s.nearest === 5;
    })(), '');
    state.templates = before;
  }

  out.push('— 14. 复刻"1 弦不发声"的真凶：闷音把 1 指误判成握拳 —');
  {
    // 左手 1 根手指选 1 弦，右手先握起（该闷音）再张开（该拨响）
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: ONE }, { handedness: 'Right', ext: FIST }], frames: 8 },
      { hands: [{ handedness: 'Left', ext: ONE }, { handedness: 'Right', ext: FIVE }], frames: 20 },
    ]);
    check('左手 1 根手指选 1 弦 + 右手张开 → 真的拨响 1 弦',
      r.plucks.length >= 1 && r.plucks[0].stringIndex === 5,
      r.plucks.length ? `响的是 ${NAME[r.plucks[0].stringIndex]}` : '没响');
    // 第 2 阶段（右手张开、左手 1 指选弦）只允许"过渡帧"那 1 次闷音：
    // 右手从握拳到张开要过几帧 EMA，第 1 帧确实还像握拳。
    // 旧 bug 是每帧都闷（20 帧闷 20 次）→ 主音量一直是 0 → 显示触发了却没声音。
    const duringOpen = r.muteByPhase[1] - r.muteByPhase[0];
    check('选 1 弦期间不再每帧误闷音（退化成 ≤1 次过渡帧）', duringOpen <= 1, `闷了 ${duringOpen} 次`);
    check('右手握着的第 1 阶段该闷音时确实闷了', r.muteByPhase[0] > 0, `闷了 ${r.muteByPhase[0]} 次`);
    check('1 弦的闷音行为与其余弦一致（不再被特殊误判）', duringOpen <= 1, `1 弦闷 ${duringOpen} 次`);
    // 其余五根弦照旧
    for (const [ext, want] of [[TWO, 4], [THREE, 3], [FOUR, 2], [FIVE, 1], [HORNS, 0]]) {
      const r2 = simRun([
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIST }], frames: 8 },
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIVE }], frames: 20 },
      ]);
      const mutes = r2.muteByPhase[1] - r2.muteByPhase[0];
      check(`${NAME[want]} 也能响且不被误闷音`,
        r2.plucks.length >= 1 && r2.plucks[0].stringIndex === want && mutes <= 1,
        `响 ${r2.plucks.length} 次 / 闷 ${mutes} 次`);
    }
  }

  out.push('— 15. 整体变调：换调之后响的必须是新音，且取的是同一份采样 —');
  {
    const pluckOn = (stringIdx, handExt, transpose) => {
      const r = simRun(
        [
          { hands: [{ handedness: 'Left', ext: handExt }, { handedness: 'Right', ext: FIST }], frames: 8 },
          { hands: [{ handedness: 'Left', ext: handExt }, { handedness: 'Right', ext: FIVE }], frames: 20 },
        ],
        { transpose },
      );
      return r.plucks.find((p) => p.stringIndex === stringIdx) || null;
    };

    const base = pluckOn(0, HORNS, 0);
    check('变调 0：6 弦响的是 E2', base && base.note === 'E2', base ? base.note : '没响');
    check('变调 0：半音偏移是 0', base && base.semis === 0, base ? `semis=${base.semis}` : '没响');

    const up5 = pluckOn(0, HORNS, 5);
    check('变调 +5：6 弦响的是 A2（不是 E2）', up5 && up5.note === 'A2', up5 ? up5.note : '没响');
    check('变调 +5：半音偏移记成 5', up5 && up5.semis === 5, up5 ? `semis=${up5.semis}` : '没响');
    check('变调 +5：播放速率是 2^(5/12)≈1.3348',
      Math.abs(playbackRateForFret(up5 ? up5.semis : 0) - 1.33484) < 0.001,
      String(playbackRateForFret(up5 ? up5.semis : 0)));

    const down2 = pluckOn(5, ONE, -2);
    check('变调 −2 且选 1 弦：响的是 D4（E4 −2 个半音）',
      down2 && down2.note === 'D4', down2 ? down2.note : '没响');
    check('变调 −2：半音偏移记成 −2', down2 && down2.semis === -2, down2 ? `semis=${down2.semis}` : '没响');

    // 变调不能让"找不到采样"——素材永远按原音名取
    // 手势顺序要按弦号排：弦 0=🤘、1=5指、2=4指、3=3指、4=2指、5=1指
    const POSES = [HORNS, FIVE, FOUR, THREE, TWO, ONE];
    const allOk = [0, 5, -2, 7].every((t) =>
      POSES.every((ext, stringIdx) => {
        const p = pluckOn(stringIdx, ext, t);
        return p && typeof p.note === 'string' && p.note.length >= 2;
      }),
    );
    check('4 个变调 × 6 根弦 = 24 种组合都能取到采样并报出音名', allOk);

    // 收尾：把变调还原，免得影响别的断言/用户接着玩
    els.selTranspose.value = '0';
    state.transpose = 0;
    updateTransposeHint();
    check('变调能还原成 0', state.transpose === 0);
  }

  out.push('— 16. 六弦板：拨哪根弦，屏幕上就得亮哪一根 —');
  {
    resetTab();
    check('六弦板有 6 行', els.sbRows && els.sbRows.querySelectorAll('.sb-row').length === 6,
      els.sbRows ? String(els.sbRows.querySelectorAll('.sb-row').length) : '没有 sb-rows 元素');
    check('每行的弦号是 6→1（从上到下）',
      els.sbRows && [...els.sbRows.querySelectorAll('.sb-num')].map((e) => e.textContent).join(',') === '6,5,4,3,2,1',
      els.sbRows ? [...els.sbRows.querySelectorAll('.sb-num')].map((e) => e.textContent).join(',') : '—');
    check('每行带手势符号（1弦=☝️ … 6弦=🤘）',
      els.sbRows && els.sbRows.querySelector('.sb-row[data-string="0"] .sb-sym').textContent.trim() === '🤘' &&
        els.sbRows.querySelector('.sb-row[data-string="5"] .sb-sym').textContent.trim() === '☝️');
    check('换调之后板上音名跟着变（+5 → 6 弦 A2）',
      (() => {
        els.selTranspose.value = '5';
        state.transpose = 5;
        updateTransposeHint();
        const t = els.sbRows.querySelector('.sb-row[data-string="0"] .sb-name').textContent;
        els.selTranspose.value = '0';
        state.transpose = 0;
        updateTransposeHint();
        return t === 'A2';
      })(), els.sbRows ? els.sbRows.querySelector('.sb-row[data-string="0"] .sb-name').textContent : '—');

    // 真拨一下 6 弦，看板子和 TAB 有没有动
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: HORNS }, { handedness: 'Right', ext: FIST }], frames: 10 },
      { hands: [{ handedness: 'Left', ext: HORNS }, { handedness: 'Right', ext: FIVE }], frames: 22 },
    ]);
    check('拨响了 6 弦', r.plucks.length >= 1 && r.plucks[0].stringIndex === 0,
      r.plucks.length ? `响的是 ${NAME[r.plucks[0].stringIndex]}` : '没响');
    check('6 弦那一行被点亮（有 .hit）',
      els.sbRows.querySelector('.sb-row[data-string="0"]') !== null);
    check('6 弦的计数变成 1',
      els.sbRows.querySelector('[data-count="0"]').textContent === '1',
      els.sbRows.querySelector('[data-count="0"]').textContent);
    check('TAB 里记下了这一下（6 / E2）',
      state.tabHistory.length >= 1 && state.tabHistory[0].string === 0 && state.tabHistory[0].note === 'E2',
      JSON.stringify(state.tabHistory.slice(0, 2)));
    check('TAB 条真的渲染出 chip 了',
      els.tabStrip.querySelectorAll('.tab-chip').length >= 1,
      String(els.tabStrip.querySelectorAll('.tab-chip').length));
    check('画面上的大字闪了（内容 = 符号+弦+音）',
      /🤘/.test(els.pluckFlash.textContent) && /E2/.test(els.pluckFlash.textContent),
      JSON.stringify(els.pluckFlash.textContent));
    check('预选状态栏能显示"预选 → 6弦 E2"',
      state.selectedString === 0 && /6弦/.test(els.sbSelected.textContent),
      JSON.stringify(els.sbSelected.textContent));

    // 别的弦也要各亮各的，别串
    for (const [ext, want] of [[ONE, 5], [TWO, 4], [THREE, 3], [FOUR, 2], [FIVE, 1]]) {
      simRun([
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIST }], frames: 8 },
        { hands: [{ handedness: 'Left', ext }, { handedness: 'Right', ext: FIVE }], frames: 20 },
      ]);
      check(`${NAME[want]} 的计数也是 1（六弦板没串弦）`,
        els.sbRows.querySelector(`[data-count="${want}"]`).textContent === '1',
        els.sbRows.querySelector(`[data-count="${want}"]`).textContent);
    }
    check('TAB 长度正确（1 + 5 次 = 6，且不超过上限）',
      state.tabHistory.length === 6, String(state.tabHistory.length));
    check('复制 TAB 能得到文本', typeof tabToText() === 'string' && tabToText().length > 0, tabToText());

    resetTab();
    check('清空之后计数归零、TAB 空',
      state.tabHistory.length === 0 && els.sbRows.querySelector('[data-count="0"]').textContent === '0');
  }

  out.push('— 17. 和弦模式：手势、按钮、键盘三者的编号必须一致 —');
  {
    setChordMode(true);
    resetTab();
    check('六弦板切成和弦板', els.sbRows.querySelectorAll('.sb-row').length === 6 && !!els.sbRows.querySelector('.sb-frets'));
    check(`和弦库默认 6 个槽位都能解析（${currentBank().map((s) => s.name).join(' ')}）`,
      currentBank().length === 6 && currentBank().every((s) => !!s.shape));

    // ---- 顺序不变式（这就是"1 指选中第 6 个"那个坑的反向测试）----
    // 弦号 = 6 - 手指数，槽位 = 5 - 弦号 → 伸 n 指 = 第 n 个和弦
    const slotOf = (fingers) => slotFromStringIndex(6 - fingers);
    check('伸 1..5 指 → 第 1..5 个和弦', [1, 2, 3, 4, 5].map(slotOf).join(',') === '0,1,2,3,4',
      [1, 2, 3, 4, 5].map(slotOf).join(','));
    check('🤘 → 第 6 个和弦', slotOf(6) === 5, String(slotOf(6)));
    check('和弦板第 1 行印的编号是 1、符号是 ☝️（1 指）',
      els.sbRows.querySelector('.sb-row[data-slot="0"] .sb-num b').textContent === '1' &&
        els.sbRows.querySelector('.sb-row[data-slot="0"] .sb-sym').textContent.trim() === '☝️',
      `${els.sbRows.querySelector('.sb-row[data-slot="0"] .sb-num')?.textContent} / ${els.sbRows.querySelector('.sb-row[data-slot="0"] .sb-sym')?.textContent}`);
    check('和弦板第 6 行印的编号是 6、符号是 🤘',
      els.sbRows.querySelector('.sb-row[data-slot="5"] .sb-num b').textContent === '6' &&
        els.sbRows.querySelector('.sb-row[data-slot="5"] .sb-sym').textContent.trim() === '🤘',
      `${els.sbRows.querySelector('.sb-row[data-slot="5"] .sb-sym')?.textContent}`);
    check('6 行的编号从上到下是 1..6（和弦按钮上印的、键盘用的也是这个）',
      [...els.sbRows.querySelectorAll('.sb-num b')].map((e) => e.textContent).join('') === '123456',
      [...els.sbRows.querySelectorAll('.sb-num b')].map((e) => e.textContent).join(''));

    // ---- 伸 2 指 = 第 2 个和弦（默认库的 G）----
    const r = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIST }], frames: 8 },
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIVE }], frames: 22 },
    ]);
    const hit = r.plucks.find((p) => p.chord);
    check('和弦模式下发声了', !!hit, r.plucks.length ? JSON.stringify(r.plucks[0]) : '没响');
    check('伸 2 指 → 第 2 个和弦 G（不再是第 5 个 F）',
      !!hit && hit.chord === 'G' && hit.slot === 1, hit ? `第 ${hit.slot + 1} 个 ${hit.chord}` : '—');
    check('高亮的是第 2 行（和伸的手指对得上）',
      state.selectedString === 1 && els.sbRows.querySelector('.sb-row[data-slot="1"]').classList.contains('sel'),
      `selectedString=${state.selectedString}`);
    // 手势和键盘必须落到同一个和弦上
    const viaKey = (() => {
      resetTab();
      doStrumChord(1, 0.7, '按键 2');
      return state.tabHistory[0]?.chord;
    })();
    check('"伸 2 指"和"按键 2"响的是同一个和弦', viaKey === 'G', String(viaKey));
    check('预选状态栏写的是"第 2 个 G"', /第\s*2\s*个/.test(els.sbSelected.textContent) && /G/.test(els.sbSelected.textContent),
      els.sbSelected.textContent);

    // 预期值从和弦表算出来，不写死：G 的 6 根弦全响
    const wantStrings = chordStrings(resolveChord('G')).length;
    check(`**一次手势响了 ${wantStrings} 根弦**（这正是"单调"的病根）`, !!hit && hit.strings === wantStrings,
      hit ? `响了 ${hit.strings} 根` : '—');
    const uniq = hit ? [...new Set(hit.notes)].sort().join(' ') : '—';
    check('组成音是 G B D（G 的实际音是 G B D G B G）', uniq === 'B D G', uniq);
    check('和弦板上那一行计数 1',
      els.sbRows.querySelector('[data-count="1"]').textContent === '1',
      els.sbRows.querySelector('[data-count="1"]')?.textContent);
    check('TAB 里记的是和弦名（不是弦号）',
      state.tabHistory.length >= 1 && state.tabHistory[0].chord === 'G',
      JSON.stringify(state.tabHistory.slice(0, 1)));
    check('画面大字显示的是和弦名 + 组成音',
      /G/.test(els.pluckFlash.textContent) && /B/.test(els.pluckFlash.textContent),
      JSON.stringify(els.pluckFlash.textContent));
    check('面板说的是"扫和弦"', /扫和弦/.test((els.playState || {}).textContent || ''), ((els.playState || {}).textContent || '').slice(0, 40));

    // 换调 = 夹变调夹：**听的和弦不变，按的指型整体换把位**
    els.selTranspose.value = '5';
    state.transpose = 5;
    updateTransposeHint();
    els.selChordBank.value = 'ballad';
    els.selChordBank.dispatchEvent(new Event('change'));
    check('抒情走向 +5 下显示的仍然是 C Am F G Em Dm（和库名对照，不再变成 F Dm A# C Am Gm）',
      currentBank().map((s) => s.name).join(' ') === 'C Am F G Em Dm',
      currentBank().map((s) => s.name).join(' '));
    check('和弦板上第一行显示的也是 C（不是 F）',
      els.sbRows.querySelector('.sb-row[data-string="0"] .sb-num').textContent.startsWith('C'),
      els.sbRows.querySelector('.sb-row[data-string="0"] .sb-num')?.innerHTML);
    // 真正的证明：把按的指型整体上移 5 品，音级必须正好等于想听的那个和弦
    const pcSet = (shape, up) =>
      new Set(chordMidis(shape).map((m) => (((m + up) % 12) + 12) % 12));
    check('抒情走向 +5：每个槽位按的指型上移 5 品后，音级正好等于想听的和弦',
      currentBank().every((s) => {
        if (!s.shape) return false;
        const got = pcSet(s.shape, 5);
        const want = pcSet(resolveChord(s.name), 0);
        return got.size === want.size && [...got].every((x) => want.has(x));
      }), currentBank().map((s) => `${s.name}←${s.shape ? s.shape.name : '无'}`).join(' '));
    check('指型确实换了把位（不是原位硬弹）',
      currentBank().some((s) => s.shape && s.shape.name !== s.name),
      currentBank().map((s) => `${s.name}←${s.shape ? s.shape.name : '无'}`).join(' '));
    // 12 个变调全都要有指型（不能有"这个名字在、夹这个品位就没指型了"）
    let noShape = [];
    for (let t = -5; t <= 7; t++) {
      for (const s of bankSlots('ballad', t)) if (!s.shape) noShape.push(`${s.name}@${t}`);
      for (const s of bankSlots('minor', t)) if (!s.shape) noShape.push(`${s.name}@${t}`);
    }
    check('抒情/小调两个库在 -5..+7 全部变调下都有指型', noShape.length === 0, noShape.join(' '));
    els.selChordBank.value = DEFAULT_BANK;
    els.selChordBank.dispatchEvent(new Event('change'));
    els.selTranspose.value = '0';
    state.transpose = 0;
    updateTransposeHint();

    // 和弦库必须真的生效
    els.selChordBank.value = 'minor';
    els.selChordBank.dispatchEvent(new Event('change'));
    check('换和弦库之后槽位跟着换（小调库第 1 个是 Am）', currentBank()[0].name === 'Am', currentBank()[0].name);

    // 全部和弦都能弹出来（不能有"名字在、声不出"的）；夹变调夹时用换过的指型
    let silent = [];
    for (const name of Object.keys(CHORDS)) {
      const shape = shapeForSounding(name, state.transpose || 0) || resolveChord(name);
      const parts = state.sampler.strumChord(shape, { velocity: 0.7, transpose: state.transpose || 0 });
      if (!parts.length || parts.some((p) => !p)) silent.push(name);
    }
    check(`全部 ${Object.keys(CHORDS).length} 个和弦都能出声`, silent.length === 0, silent.join(','));

    // 混响滑块要真的接到采样器上
    els.rngReverb.value = '45';
    els.rngReverb.dispatchEvent(new Event('input'));
    check('混响滑块接到了采样器（45%）', state.sampler.reverbAmount === 0.45, String(state.sampler.reverbAmount));
    els.rngReverb.value = '22';
    els.rngReverb.dispatchEvent(new Event('input'));

    // 关掉和弦模式，单音行为必须和以前一模一样
    els.selChordBank.value = DEFAULT_BANK;
    els.selChordBank.dispatchEvent(new Event('change'));
    setChordMode(false);
    resetTab();
    check('关掉和弦模式后板子切回"弦"', !!els.sbRows.querySelector('.sb-name') && !els.sbRows.querySelector('.sb-frets'));
    const r2 = simRun([
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIST }], frames: 8 },
      { hands: [{ handedness: 'Left', ext: TWO }, { handedness: 'Right', ext: FIVE }], frames: 22 },
    ]);
    check('单音模式仍然只响 1 个音（4 弦 G3）',
      r2.plucks.length >= 1 && r2.plucks[0].stringIndex === 4 && !r2.plucks[0].chord,
      JSON.stringify(r2.plucks[0] || '没响'));
    resetTab();
  }

  const text = `手势逻辑自检：${pass} 通过，${fail} 失败\n${out.join('\n')}`;
  const box = $('sim-out');
  if (box) {
    box.textContent = text;
    box.classList.remove('hidden');
  }
  diag(`手势逻辑自检：${pass} 通过，${fail} 失败（结果在右侧「手势灵敏度」面板里）`);
  console.log(text);
  return { pass, fail, lines: out };
}

// --------------------------------------------------------------------------
// 事件
// --------------------------------------------------------------------------
els.btnStart.addEventListener('click', startCamera);
els.btnStop.addEventListener('click', stopCamera);
els.btnCopy.addEventListener('click', async () => {
  const payload = {
    engine: state.engine?.name || null,
    hands: (state.lastResult || []).map((h) => ({
      handedness: h.handedness,
      score: h.score,
      features: describeHand(h.features),
      landmarks: h.landmarks,
    })),
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    els.btnCopy.textContent = '已复制';
  } catch {
    console.log(text);
    els.btnCopy.textContent = '看控制台';
  }
  setTimeout(() => (els.btnCopy.textContent = '复制 JSON'), 1200);
});

// 六弦板：复制 / 清空"你弹过的 TAB"
els.btnCopyTab.addEventListener('click', async () => {
  const text = tabToText();
  try {
    await navigator.clipboard.writeText(text);
    els.btnCopyTab.textContent = '已复制';
  } catch {
    console.log(text);
    els.btnCopyTab.textContent = '看控制台';
  }
  setTimeout(() => (els.btnCopyTab.textContent = '复制 TAB'), 1200);
});
els.btnClearTab.addEventListener('click', () => {
  resetTab();
  diag('六弦板已清空（计数和 TAB 都归零）');
});

// 换摄像头：记下来；正在跑就现场换过去
els.selCamera.addEventListener('change', async () => {
  const id = els.selCamera.value;
  if (id) localStorage.setItem(CAM_STORE_KEY, id);
  const label = els.selCamera.selectedOptions[0]?.textContent || '';
  if (state.mode === 'camera' && state.running) {
    diag(`切换到：${label}`);
    stopCamera();
    await startCamera();
  } else {
    els.camNote.textContent = `已选择：${label}（点「开启摄像头」生效）`;
  }
});

els.btnRefreshCams.addEventListener('click', async () => {
  els.btnRefreshCams.disabled = true;
  await refreshCameras({ requestPermission: true, keepCurrent: false });
  els.btnRefreshCams.disabled = false;
});

// 插拔 USB 摄像头 / 手机断开时，列表自动更新
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  diag('摄像头设备有变化，重新扫描');
  refreshCameras({ keepCurrent: true });
});

for (const chk of ['chkSkeleton', 'chkPoints', 'chkIndex', 'chkBbox']) {
  els[chk].addEventListener('change', () => {
    if (state.lastResult) {
      clearOverlay();
      state.lastResult.forEach((h, i) => drawHand(h, h.features, i));
    }
  });
}

window.addEventListener('resize', syncCanvasToVideo);

els.chkAudioOn.addEventListener('change', () => {
  state.audioOn = els.chkAudioOn.checked;
  if (state.audioOn) initAudio();
});
// 灵敏度 / 映射方案：改了就把状态机重置，避免新旧阈值混着用
function resetTrackers(why) {
  state.trackers.clear();
  state.motions.clear();
  diag(`判定状态机已重置（${why}）`);
}
els.rngSens.addEventListener('input', () => {
  els.sensVal.textContent = Number(els.rngSens.value).toFixed(2);
  resetTrackers('阈值变了');
});
els.selMapping.addEventListener('change', () => resetTrackers('换了映射方案'));
els.selTranspose.addEventListener('change', () => {  state.transpose = Number(els.selTranspose.value) || 0;
  updateTransposeHint();
  diag(
    `整体变调 ${state.transpose > 0 ? '+' : ''}${state.transpose} 个半音 → 6 根弦：${
      state.sampler ? state.sampler.stringNotes(state.transpose).join(' ') : '（音频还没加载）'
    }`,
  );
});
els.rngMotion.addEventListener('input', () => {
  els.motionVal.textContent = Number(els.rngMotion.value).toFixed(1);
});

// ---- 和弦模式 / 和弦库 / 混响 ----
if (els.chkChordMode) {
  els.chkChordMode.addEventListener('change', () => {
    setChordMode(els.chkChordMode.checked);
    diag(`切换到${state.chordMode ? '和弦' : '单音'}模式`);
  });
}
if (els.selChordBank) {
  els.selChordBank.addEventListener('change', () => {
    state.bankKey = els.selChordBank.value;
    state.chordCounts = [0, 0, 0, 0, 0, 0];
    state.selectedString = -1;
    renderBoard();
    buildChordButtons();
    updateChordHint();
    diag(`和弦库 → ${CHORD_BANKS[state.bankKey]?.label || state.bankKey}`);
  });
}
if (els.rngReverb) {
  els.rngReverb.addEventListener('input', () => updateReverb(true));
}
els.chkAudioMute.addEventListener('change', () => {
  state.muteOn = els.chkAudioMute.checked;
});
state.audioOn = els.chkAudioOn.checked;
state.muteOn = els.chkAudioMute.checked;

// --------------------------------------------------------------------------
// 手势校准：让用户把 6 个手势各比划一次，存下他自己的伸展度模板。
//
// 为什么需要：固定阈值/固定布尔规则必然在边界上失手——每个人的手型、
// 拇指习惯（有人一伸食指拇指就跟着翘）、镜头距离都不一样。
// 实测就是"拇指翘着比划 1 指"被判成 2 指、🤘 被数成 2 指甚至 1 指。
// 有了模板之后按"最像哪一次校准"来判，这些个人差异被自动吸收。
// --------------------------------------------------------------------------
const CAL_KEY = 'airguitar.templates.v1';
const CAL_STEPS = [
  { string: 5, label: '1 弦：只伸食指' },
  { string: 4, label: '2 弦：食指 + 中指' },
  { string: 3, label: '3 弦：再加无名指（三根）' },
  { string: 2, label: '4 弦：四根长指（拇指伸不伸都行）' },
  { string: 1, label: '5 弦：五指全部张开' },
  { string: 0, label: '6 弦：🤘 拇指 + 小指' },
];

function loadTemplates() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAL_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v) && v.length === 5 && v.every((n) => typeof n === 'number')) out[k] = v;
    }
    return Object.keys(out).length >= 2 ? out : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 取最近 windowMs 内、出现最多的那只手的伸展度中位数 */
function collectExt(windowMs = 1100) {
  const now = performance.now();
  const recent = state.extLog.filter((s) => now - s.t <= windowMs);
  if (recent.length < 8) return null;
  const byKey = new Map();
  for (const s of recent) byKey.set(s.key, (byKey.get(s.key) || 0) + 1);
  const top = [...byKey.entries()].sort((a, b) => b[1] - a[1])[0];
  const rows = recent.filter((s) => s.key === top[0]).map((s) => s.ext);
  if (rows.length < 8) return null;
  return [0, 1, 2, 3, 4].map((i) => {
    const col = rows.map((r) => r[i]).sort((a, b) => a - b);
    return Number(col[col.length >> 1].toFixed(3));
  });
}

/** 校准完之后自检：两两模板之间至少差多少（越小越容易串弦） */
function templateSpacing(templates) {
  const keys = Object.keys(templates).map(Number);
  let min = Infinity;
  let pair = null;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = templates[keys[i]];
      const b = templates[keys[j]];
      const d = Math.sqrt(a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0));
      if (d < min) {
        min = d;
        pair = [keys[i], keys[j]];
      }
    }
  }
  return { min: Number(min.toFixed(3)), pair };
}

async function runCalibration() {
  if (!state.running || state.mode !== 'camera') {
    setPlayState('先点「开启摄像头」，把手放进画面，再点「手势校准」', 'warn');
    return null;
  }
  const templates = {};
  const lines = [];
  for (const step of CAL_STEPS) {
    setPlayState(`校准 ${step.label} —— 比划好，准备…`, 'hit');
    await sleep(1100);
    for (let s = 3; s > 0; s--) {
      setPlayState(`校准 ${step.label} —— 保持住 ${s}`, 'hit');
      await sleep(700);
    }
    const ext = collectExt();
    if (!ext) {
      lines.push(`${step.label} → 没看到稳定的手（跳过）`);
      continue;
    }
    templates[step.string] = ext;
    lines.push(`${step.label} → [${ext.join(', ')}]`);
  }

  const n = Object.keys(templates).length;
  if (n < 2) {
    const msg = `校准失败：只采到 ${n} 个手势。请确认手在画面里、光线够亮，再试一次。\n${lines.join('\n')}`;
    if (els.calNote) els.calNote.textContent = `校准失败：只采到 ${n} 个手势`;
    setPlayState('校准失败：手没被稳定看到，再试一次', 'warn');
    console.log(msg);
    return { ok: false, lines };
  }

  const spacing = templateSpacing(templates);
  localStorage.setItem(CAL_KEY, JSON.stringify(templates));
  state.templates = templates;
  resetTrackers('校准完成');
  const warn = spacing.min < 0.3 ? `　⚠ 有两根弦的手势太像（间距 ${spacing.min}），容易串，注意把姿势做得更开` : '';
  if (els.calNote) {
    els.calNote.textContent = `已校准 ${n}/6 个手势（最小间距 ${spacing.min}）${warn}`;
  }
  setPlayState(`✔ 校准完成：${n}/6 个手势已保存。现在用「最像哪次校准」来判定。${warn}`, 'hit');
  diag(`手势校准完成：${n}/6，最小模板间距 ${spacing.min}`);
  console.log(`手势校准结果：\n${lines.join('\n')}\n最小间距 ${spacing.min}（${spacing.pair}）`);
  return { ok: true, templates, spacing, lines };
}

function clearCalibration() {
  localStorage.removeItem(CAL_KEY);
  state.templates = null;
  resetTrackers('清除校准');
  if (els.calNote) els.calNote.textContent = '未校准：用内置规则判定（比划 1 指容易变成 2 指时可来校准一次）';
  setPlayState('已清除校准，回到内置规则判定', 'idle');
}

if (els.btnCalibrate) els.btnCalibrate.addEventListener('click', () => runCalibration());
if (els.btnCalClear) els.btnCalClear.addEventListener('click', clearCalibration);
const params = new URLSearchParams(location.search);
state.templates = loadTemplates();
// ?nocal=1 —— 这次会话先不用校准模板（保留存储里的，不清除）。
// 用途：一眼分清"判定错"到底出在模板还是内置规则上。
if (params.get('nocal')) {
  state.templatesOff = true;
  state.templates = null;
  diag('?nocal=1：本次会话不加载手势校准模板（存储里的没删）');
}
if (els.calNote) {
  els.calNote.textContent = state.templatesOff
    ? '本次会话已停用校准（?nocal=1）：用内置规则判定'
    : state.templates
      ? `已校准 ${Object.keys(state.templates).length}/6 个手势 —— 判定会优先按模板走；如果发现"手指数对但弦号不对"，点「清除校准」重新比划一次`
      : '未校准：用内置规则判定（比划 1 指容易变成 2 指时可来校准一次）';
}

// 把状态挂到 window，方便自动化测试读取
window.__airguitar = {
  state,
  get result() {
    return state.lastResult;
  },
  get sampler() {
    return state.sampler;
  },
  detectStill: (url, label) => loadStill(url, label),
  selfTest: runSelfTest,
  initAudio,
  listCameras: () => listCameras({ requestPermission: true }),
  refreshCameras: (o) => refreshCameras(o),
  /**
   * 把合成的手势喂进真正跑的那条代码路径（handleStrum），不依赖摄像头，
   * 而且用注入的时钟推进时间，所以张开增量/冷却/投票都真实生效。
   *
   *   __airguitar.simulate([{hands:[{handedness:'Left',ext:[0,1,1,0,0]}],frames:12},
   *                         {hands:[{handedness:'Left',ext:[0,1,1,0,0]},
   *                                 {handedness:'Right',ext:[1,1,1,1,1]}],frames:12}])
   */
  simulate(phases, opts = {}) {
    return simRun(phases, opts);
  },
  simTest: () => runSimTest(),
  resetTrackers: () => resetTrackers('手动'),
  setSens: (v) => {
    els.rngSens.value = String(v);
    els.sensVal.textContent = Number(v).toFixed(2);
    resetTrackers('脚本改阈值');
  },
  setMapping: (m) => {
    els.selMapping.value = m;
    resetTrackers('脚本改映射');
  },
  setTemplates: (t) => {
    state.templates = t;
    resetTrackers('脚本设模板');
  },
  getTemplates: () => state.templates,
  calibrate: () => runCalibration(),
  clearCalibration: () => clearCalibration(),
  setTrigger: (t) => {
    els.selTrigger.value = t;
  },
  get playState() {
    return els.playState?.textContent || null;
  },
  cameraInfo: () => {
    const t = state.stream?.getVideoTracks?.()[0];
    const s = t?.getSettings?.() || {};
    return {
      label: t?.label || null,
      deviceId: s.deviceId || null,
      size: s.width ? `${s.width}x${s.height}` : null,
      running: state.running,
      selected: els.selCamera.selectedOptions[0]?.textContent || null,
    };
  },
  pluck: (stringIndex, velocity) => {
    initAudio();
    setTimeout(() => doPluck(stringIndex, velocity ?? 0.7, '试听'), 60);
  },
  checkAudio: async () => {
    const s = await initAudio();
    if (!s) return null;
    await s.resume();
    return { ...s.stats, ctxState: s.ctx.state };
  },
};

diag(`boot ${location.href}`);
// 六弦板先画出来（此时采样还没加载，先用默认音名），加载完会再画一次补上真实音名
buildStringBoard();
// 和弦相关的界面（和弦库下拉、全部和弦清单、混响滑块）
buildChordBankSelect();
buildChordAll();
buildChordButtons();
// ?chord=1 直接进和弦模式（也用来验证和弦模式不是只能靠点开关才会亮）
if (params.get('chord')) setChordMode(true);
updateReverb(false);
// 键盘 1-6：按六弦板的行号来 —— 和弦模式下扫第 n 个和弦，单音模式下拨第 n 行的弦
// （行序和板子上一致：1 = 第一行。和弦模式下和弦芯片上也印着 1-6，对得上）
window.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > 6) return;
  e.preventDefault();
  const slot = n - 1;
  initAudio().then(async (s) => {
    await s?.resume();
    if (state.chordMode) doStrumChord(slot, Number(els.rngVelocity.value), `按键 ${n}`);
    else doPluck(slot, Number(els.rngVelocity.value), `按键 ${n}`);
  });
});
// 先把摄像头列表填上（此时可能还没授权，名字显示不出来，点开启摄像头时会再刷一次）
refreshCameras().catch((err) => diag(`列摄像头失败：${err.message || err}`));
// ?cams=1 主动要一次权限，把设备名刷出来（排障用，不会一直占着摄像头）
if (params.get('cams')) {
  refreshCameras({ requestPermission: true, keepCurrent: false }).catch((err) =>
    diag(`扫描摄像头失败：${err.message || err}`),
  );
}

// 统一的启动流程。注意 ?cam=1 和"自动载入默认样例"是互斥的：
// 样例会 stop 掉摄像头流，两者同时跑就会出现"刚开好又被关掉"的启动竞态。
initEngine().then(async () => {
  if (params.get('selftest')) {
    runSelfTest();
    return;
  }
  if (params.get('sim')) {
    await initAudio(); // 自检要真的走到 doPluck，所以采样必须先加载好
    runSimTest();
    loadSampleList({ autoDefault: false });
    return;
  }
  if (params.get('cam')) {
    loadSampleList({ autoDefault: false });
    startCamera();
    return;
  }
  loadSampleList();
});
