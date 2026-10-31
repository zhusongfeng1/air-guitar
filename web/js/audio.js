/**
 * 吉他采样器：把 tools/fetch_guitar_samples.py 裁出来的 18 个 wav 播成一把琴。
 *
 * 纯逻辑部分（力度分层、品丝变调、扫弦排期、混响脉冲响应）单独导出，可以在 Node 里单测；
 * 需要 AudioContext 的部分才放在 GuitarSampler 里。
 */
import { chordStrings, resolve } from './chords.js';

/** 力度 → 力度层。三层采样，阈值之间做插值补音量。 */
export const LAYERS = ['pp', 'mf', 'ff'];
export const LAYER_THRESHOLDS = [0.45, 0.85];

export function pickLayer(velocity) {
  const v = Math.max(0, Math.min(1, velocity));
  if (v < LAYER_THRESHOLDS[0]) return 'pp';
  if (v < LAYER_THRESHOLDS[1]) return 'mf';
  return 'ff';
}

/** 同一层内的音量补偿：让 pp/mf/ff 之间过渡时音量连续。 */
export function layerGain(velocity) {
  const v = Math.max(0, Math.min(1, velocity));
  const layer = pickLayer(v);
  const center = layer === 'pp' ? 0.22 : layer === 'mf' ? 0.65 : 1.0;
  // 该层代表 0.22 / 0.65 / 1.0 的力度，简单按比例缩放
  return Math.max(0.05, Math.min(1.4, v / center));
}

/** 品丝 → 播放速率（每品一个半音）。fret=0 就是空弦原音。 */
export function playbackRateForFret(fret, cents = 0) {
  return Math.pow(2, (fret + cents / 100) / 12);
}

/**
 * 扫弦排期：给一组弦号排出发声时刻（毫秒偏移）。
 * 从低音弦往高音弦扫，或者反过来，相邻弦间隔 spreadMs。
 */
export function pluckSchedule(stringIndices, { spreadMs = 35, down = true } = {}) {
  const sorted = [...stringIndices].sort((a, b) => (down ? a - b : b - a));
  return sorted.map((string, i) => ({ string, offsetMs: i * spreadMs }));
}

/** 频率（音名 → Hz），备用：以后要按音高而不是弦号发声时用。 */
export function noteToHz(note) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  if (!m) throw new Error(`不认识的音名 ${note}`);
  const semi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + semi + acc;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 音名 → MIDI 号 */
export function noteToMidi(note) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  if (!m) throw new Error(`不认识的音名 ${note}`);
  const semi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + semi + acc;
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 号 → 音名（只用升号，够用了） */
export function midiToNote(midi) {
  const n = Math.round(midi);
  return `${SHARP_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * 音名整体平移 N 个半音。
 * 用来做"整体变调"：整把琴一起升/降，好对上歌曲的调。
 */
export function transposeNote(note, semitones = 0) {
  return midiToNote(noteToMidi(note) + Math.round(semitones));
}

// --------------------------------------------------------------------------
// 混响：自己合成脉冲响应，不用外部文件（保持"零 CDN、离线可用"）。
//
// 之前整把琴是"干"的：一次只响一根弦、还没一点空间感，听起来就很单薄。
// 这里的做法和真房间一致 —— 高频先衰减、尾巴按幂次变暗。
// 用固定种子的伪随机数，保证每次生成的响应一样（测试才能复现）。
// --------------------------------------------------------------------------

/** 线性同余伪随机（-1..1），固定种子 → 结果可复现 */
function makeRand(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/**
 * 生成两声道脉冲响应数据（纯函数，Node 里也能单测）。
 * @returns {Float32Array[]} [左, 右]
 */
export function impulseData(rate, seconds = 1.8, decay = 2.6, seed = 12345) {
  const len = Math.max(1, Math.floor(rate * seconds));
  const pre = Math.max(1, Math.floor(rate * 0.02)); // 20ms 预延迟
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const rand = makeRand(seed + ch * 7919);
    const d = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // 尾巴按 (1-t)^decay 衰减；再用一阶低通让高频先走，做出"变暗"的房间感
      const env = Math.pow(1 - t, decay);
      const n = rand() * env;
      lp += (n - lp) * (0.35 * (1 - t) + 0.04);
      d[i] = lp * 0.6 * (i < pre ? i / pre : 1);
    }
    out.push(d);
  }
  return out;
}

/** 用音频上下文生成卷积用的 AudioBuffer */
export function makeImpulse(ctx, seconds = 1.8, decay = 2.6) {
  const data = impulseData(ctx.sampleRate, seconds, decay);
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  buf.getChannelData(0).set(data[0]);
  buf.getChannelData(1).set(data[1]);
  return buf;
}

// --------------------------------------------------------------------------

export class GuitarSampler {
  constructor(ctx, buffers, manifest) {
    this.ctx = ctx;
    /** @type {Record<string, Record<string, AudioBuffer>>} buffers[note][dynamic] */
    this.buffers = buffers;
    this.manifest = manifest;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    // master → dry ──────────────────────┐
    //      └→ convolver → wet ──────────→ 输出
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.master.connect(this.dry).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    try {
      this.reverb.buffer = makeImpulse(ctx);
    } catch {
      this.reverb = null; // 极老的浏览器不支持 convolver 时退化为纯干声
    }
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    if (this.reverb) {
      this.master.connect(this.reverb);
      this.reverb.connect(this.wet).connect(ctx.destination);
    }
    /** 混响量 0..1（wet 增益上限 0.55，再多就糊了） */
    this.reverbAmount = 0;
    this._noise = null;
  }

  /** 设混响量：0 = 完全干声，1 = 最大（wet 0.55） */
  setReverb(amount) {
    const a = Math.max(0, Math.min(1, Number(amount) || 0));
    this.reverbAmount = a;
    if (!this.wet) return a;
    const t = this.ctx.currentTime;
    // 平滑过渡，拖滑块时不会"啪"一下
    this.wet.gain.cancelScheduledValues(t);
    this.wet.gain.setTargetAtTime(a * 0.55, t, 0.05);
    return a;
  }

  /**
   * 载入 manifest 并把所有 wav 解码好。
   * @param {{ctx?: AudioContext, baseUrl?: string}} opts
   */
  static async create({ ctx, baseUrl = './assets/guitar/' } = {}) {
    const audioCtx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(`${baseUrl}manifest.json`, { cache: 'no-store' });
    const manifest = await res.json();

    const buffers = {};
    const entries = await Promise.all(
      manifest.samples.map(async (s) => {
        const r = await fetch(baseUrl + s.file);
        const arr = await r.arrayBuffer();
        const buf = await audioCtx.decodeAudioData(arr);
        return { s, buf };
      }),
    );
    for (const { s, buf } of entries) {
      buffers[s.note] = buffers[s.note] || {};
      buffers[s.note][s.dynamic] = buf;
    }
    const notes = Object.keys(buffers);
    const ok = entries.filter((e) => e.buf.length > 0).length;
    return new GuitarSampler(audioCtx, buffers, manifest)._withStats(notes, ok, entries);
  }

  _withStats(notes, decoded, entries) {
    this.stats = {
      notes: notes.length,
      decoded,
      totalSamples: entries.length,
      totalSeconds: Number(entries.reduce((a, e) => a + e.buf.duration, 0).toFixed(2)),
      source: this.manifest.source,
    };
    return this;
  }

  /** 浏览器没给音频上下文"解锁"（没点过页面）时，AudioContext 会是 suspended。 */
  async resume() {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx.state;
  }

  get ready() {
    return this.ctx.state === 'running';
  }

  /** 弦号（0=6弦）→ 音名；可带整体变调 */
  noteForString(stringIndex, transpose = 0) {
    const s = this.manifest.openStrings.find((o) => o.index === stringIndex);
    if (!s) return null;
    return transpose ? transposeNote(s.note, transpose) : s.note;
  }

  /** 当前变调下 6 根弦的音名，从 6 弦到 1 弦 */
  stringNotes(transpose = 0) {
    return this.manifest.openStrings
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((o) => (transpose ? transposeNote(o.note, transpose) : o.note));
  }

  /**
   * 拨一根弦。
   * @param {number} stringIndex 0=6弦（最粗）…5=1弦
   * @param {{velocity?:number, when?:number, fret?:number, detuneCents?:number, gain?:number, transpose?:number}} opts
   */
  pluck(stringIndex, { velocity = 0.7, when = 0, fret = 0, detuneCents = 0, gain = 1, transpose = 0 } = {}) {
    // 关键：素材永远是那把琴的空弦录音，取哪个 wav 只看**原来的**音名；
    // 变调靠 playbackRate 升/降，不是换一个采样（换采样就没有这个音了）。
    const baseNote = this.noteForString(stringIndex);
    if (!baseNote) return null;
    const semis = fret + transpose;
    const note = semis ? transposeNote(baseNote, semis) : baseNote; // 显示/记录用的音名
    const layer = pickLayer(velocity);
    const byLayer = this.buffers[baseNote];
    if (!byLayer) return null;
    // 目标层没采到就退到最近的层
    const buf = byLayer[layer] || byLayer.mf || Object.values(byLayer)[0];
    if (!buf) return null;

    // 拨弦一定要把闷音解除：否则"闷音压着的时候拨一下"，音量包络会把起音整段吃掉，
    // 听起来就像"拨了但没声"（实际发过声，只是被主音量压住了）
    this.unmute();

    const t0 = this.ctx.currentTime + Math.max(0, when);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // 每根弦轻微随机失谐，避免每次听起来一模一样
    const jitter = detuneCents + (Math.random() - 0.5) * 6;
    src.playbackRate.value = playbackRateForFret(semis, jitter);

    const g = this.ctx.createGain();
    const amp = layerGain(velocity) * gain;
    g.gain.setValueAtTime(amp, t0);

    // 高音弦衰减快、低音弦余韵长：按弦号给一个轻微的包络整形
    const isBass = stringIndex <= 1;
    const hold = isBass ? 0.9 : stringIndex >= 4 ? 0.35 : 0.6;
    g.gain.setValueAtTime(amp, t0 + hold);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, amp * 0.35), t0 + buf.duration / 2);

    src.connect(g).connect(this.master);
    src.start(t0);
    this._last = src;
    return { source: src, gain: g, layer, note, baseNote, semis, startTime: t0 };
  }

  /** 扫弦：把一组弦按顺序拨出来。 */
  strum(stringIndices, { velocity = 0.75, spreadMs = 35, down = true, fret = 0 } = {}) {
    return pluckSchedule(stringIndices, { spreadMs, down }).map(({ string, offsetMs }) =>
      this.pluck(string, { velocity, when: offsetMs / 1000, fret }),
    );
  }

  /**
   * 弹一个**和弦**：按指型把每根弦用各自的品位拨出来。
   * 这才是"和弦"，之前的 strum 只能给所有弦同一个品位，弹不出 C、G 这些指型。
   *
   * @param {string|object} shapeOrName 和弦名（'C' / 'Fmaj7'…）或指型对象
   * @param {{velocity?:number, spreadMs?:number, down?:boolean, transpose?:number, gain?:number}} opts
   */
  strumChord(shapeOrName, { velocity = 0.75, spreadMs = 30, down = true, transpose = 0, gain = 1 } = {}) {
    const shape = resolve(shapeOrName);
    if (!shape) return [];
    const parts = chordStrings(shape); // [{string, fret}]，已去掉闷掉的弦
    if (!parts.length) return [];
    const fretOf = new Map(parts.map((p) => [p.string, p.fret]));
    return pluckSchedule(
      parts.map((p) => p.string),
      { spreadMs, down },
    ).map(({ string, offsetMs }) =>
      this.pluck(string, {
        velocity,
        when: offsetMs / 1000,
        fret: fretOf.get(string) || 0,
        transpose,
        gain,
      }),
    );
  }

  /** 全部停掉（闷音）。 */
  mute(fadeSeconds = 0.06) {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + fadeSeconds);
    this.master.gain.setValueAtTime(0.9, t + fadeSeconds + 0.01);
  }

  /** 解除闷音（拨弦前必调，保证起音不被压掉）。 */
  unmute(fadeSeconds = 0.012) {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.linearRampToValueAtTime(0.9, t + fadeSeconds);
  }
}
