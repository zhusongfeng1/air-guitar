"""把 University of Iowa 的吉他采样包，裁成空气吉他可用的 6 根空弦音。

Iowa MIS 的采样是按「音域段」给的：一个 aif 文件里含一串音，中间有静音分隔。
所以流程是：解码 → 切出每个音 → 自相关测基频 → 按基频挑出我们要的 6 个音。

这样"取到的是不是 E2/A2/D3/G3/B3/E4"不是靠文件名猜的，而是量出来的。

用法：
    python tools/fetch_guitar_samples.py [--zip incoming/Guitar.mono.1644.1.zip]

采样来源：University of Iowa Musical Instrument Samples (MIS)，免费使用，需署名。
https://theremin.music.uiowa.edu/MIS.html
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import sys
import wave
import zipfile

import numpy as np

# 控制台可能是 GBK，直接强制 UTF-8，免得路径/标记打出乱码或直接抛异常
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "web", "assets", "guitar")

# 6 根空弦：内部索引 0 = 6 弦（最粗）
OPEN_STRINGS = [
    {"index": 0, "name": "6弦", "note": "E2", "hz": 82.41},
    {"index": 1, "name": "5弦", "note": "A2", "hz": 110.00},
    {"index": 2, "name": "4弦", "note": "D3", "hz": 146.83},
    {"index": 3, "name": "3弦", "note": "G3", "hz": 196.00},
    {"index": 4, "name": "2弦", "note": "B3", "hz": 246.94},
    {"index": 5, "name": "1弦", "note": "E4", "hz": 329.63},
]

DYNAMICS = ["pp", "mf", "ff"]

# 每个空弦音"应该"来自哪个文件（作者按 弦+音域段 命名）。
# 注意：这只是首选来源。真正决定候选的是下面按文件名解析出的音域范围——
# 同一个音在不同弦/不同把位上都录了，首选文件里偶尔会缺这个音。
CANONICAL_SOURCE = {
    "E2": "sulE.E2B2",
    "A2": "sulA.A2B2",
    "D3": "sulD.D3B3",
    "G3": "sulG.G3B3",
    "B3": "sulB.B3.",
    "E4": "sul_E.E4B4",
}

NOTE_RE = re.compile(r"([A-G])([#b]?)(-?\d+)")
_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_to_hz(token: str) -> float:
    """'E2' -> 82.41，'Gb5' -> 739.99（十二平均律，A4=440）。"""
    m = NOTE_RE.fullmatch(token)
    if not m:
        raise ValueError(f"不认识的音名 {token!r}")
    step = _SEMITONE[m.group(1)]
    acc = m.group(2)
    step += 1 if acc == "#" else (-1 if acc == "b" else 0)
    octave = int(m.group(3))
    midi = (octave + 1) * 12 + step
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def file_pitch_range(basename: str) -> tuple[float, float] | None:
    """从文件名解析这个文件里录了哪些音，例如 Guitar.mf.sulD.D3B3.aif -> (D3, B3)。

    音域段可能是单音（B3）也可能是范围（C5Gb5），按最低/最高音处理。
    这样"这个音该去哪儿找"就是数据说了算，不用我猜弦和把位。
    """
    parts = basename.split(".")
    for part in parts[2:]:
        toks = NOTE_RE.findall(part)
        if toks:
            hz = [note_to_hz(f"{a}{b}{c}") for a, b, c in toks]
            return min(hz), max(hz)
    return None

KEEP_SECONDS = 2.6          # 每个音保留多长（吉他余韵长，低音弦尤其）
FADE_SECONDS = 0.15         # 结尾淡出，避免"咔"一下
GAP_SECONDS = 0.12          # 判定为静音的最小间隔
FRAME_SECONDS = 0.01
PEAK_TARGET = 0.89          # 归一化峰值
# 校正前允许的偏差。原录音整体偏低 ~1.7%（-29 音分），这是它的特点；
# 但**不能**宽松到"隔着半个音也算这个音" —— 相邻半音在这套半音阶录音里只差 6~7%，
# 一旦放宽到这里，选音逻辑就可能把 G#2 当成 A2。
# 0.04 ≈ 68 音分：足够容纳录音本身的偏低，又不足以跳到相邻半音。
CORRECT_TOLERANCE = 0.04
# 在"音准已经对了"的候选里，允许的额外音分窗口（同音不同弦/把位之间会有几音分的差异）
NEAR_CENTS = 30.0
# 复测写出的文件时，音高必须对到这个程度
VERIFY_TOLERANCE = 0.01

# ---- 余音（衰减）门槛：这一条是"五弦听起来和别的弦不一样"的根因 ----
# 同一套录音里，有些"音"是演奏时被手闷掉的短音：250ms 就掉 15dB，然后停在 -36dB。
# 这种文件音高完全正确、峰值也正常，所以只看音高/峰值/时长的检查全都抓不到它，
# 但拿来当空弦音就会"嗒"一声就没了。
# 下面这个名字音在 0.45~0.65s 处相对起音的电平，就是判据：
#   正常拨弦的低音弦：-3 ~ -15dB
#   被闷掉的短音：-20dB 以下
SUSTAIN_MIN_DB = -20.0
SUSTAIN_GOOD_DB = -15.0         # 低于这个值就算"这条明显短"，才考虑跨力度层借音
SUSTAIN_ATTACK = (0.03, 0.15)   # 起音取样窗口
SUSTAIN_LATER = (0.45, 0.65)    # 余音取样窗口
# 同一个音在别的力度层里如果明显更耐听，允许借过来用（见 main 里的借用逻辑）
BORROW_MARGIN_DB = 5.0
# 首选"本弦空弦那一条"时允许它比最耐听的差多少（音色更正，值得稍微牺牲一点余音）
CANON_MARGIN_DB = 4.0


# --------------------------------------------------------------------------
# 极简 AIFF 解码（Python 3.13 删了 aifc，索性自己读，反正格式就那几个块）
# --------------------------------------------------------------------------
def _read_extended(b: bytes) -> float:
    """解析 80 位 IEEE 扩展浮点（AIFF 用它存采样率）。"""
    sign = -1.0 if b[0] & 0x80 else 1.0
    exp = ((b[0] & 0x7F) << 8) | b[1]
    mant = int.from_bytes(b[2:10], "big")
    if exp == 0 and mant == 0:
        return 0.0
    return sign * mant * 2.0 ** (exp - 16383 - 63)


def read_aiff(path_or_bytes) -> tuple[np.ndarray, int]:
    """返回 (单声道 float32 [-1,1], 采样率)。支持 16/24/32 位 PCM。"""
    if isinstance(path_or_bytes, (str, os.PathLike)):
        with open(path_or_bytes, "rb") as f:
            data = f.read()
    else:
        data = path_or_bytes

    if data[:4] != b"FORM":
        raise ValueError("不是 AIFF")
    form_type = data[8:12]
    if form_type not in (b"AIFF", b"AIFC"):
        raise ValueError(f"不支持的 AIFF 类型 {form_type!r}")

    pos = 12
    n_channels = 1
    n_frames = 0
    sample_size = 16
    sample_rate = 44100
    sound = None

    while pos + 8 <= len(data):
        cid = data[pos : pos + 4]
        csize = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + csize]
        if cid == b"COMM":
            n_channels, n_frames, sample_size = struct.unpack(">hIh", body[:8])
            sample_rate = int(round(_read_extended(body[8:18])))
        elif cid == b"SSND":
            offset = struct.unpack(">I", body[:4])[0]
            sound = body[8 + offset :]
        pos += 8 + csize + (csize & 1)

    if sound is None:
        raise ValueError("没找到 SSND 数据块")

    if sample_size == 16:
        arr = np.frombuffer(sound, dtype=">i2").astype(np.float32) / 32768.0
    elif sample_size == 24:
        raw = np.frombuffer(sound, dtype=np.uint8).reshape(-1, 3)
        ints = (raw[:, 0].astype(np.int32) << 16) | (raw[:, 1].astype(np.int32) << 8) | raw[:, 2].astype(np.int32)
        ints = np.where(ints >= 1 << 23, ints - (1 << 24), ints)
        arr = ints.astype(np.float32) / float(1 << 23)
    elif sample_size == 32:
        arr = np.frombuffer(sound, dtype=">i4").astype(np.float32) / float(1 << 31)
    else:
        raise ValueError(f"没见过的位深 {sample_size}")

    if n_channels > 1:
        arr = arr.reshape(-1, n_channels).mean(axis=1)
    if n_frames:
        arr = arr[:n_frames]
    return arr, sample_rate


# --------------------------------------------------------------------------
# 切音符 / 测音高
# --------------------------------------------------------------------------
def find_segments(x: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """按 RMS 包络切出连续发声段（起止采样点）。"""
    frame = max(1, int(sr * FRAME_SECONDS))
    n = len(x) // frame
    if n == 0:
        return []
    rms = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    if rms.max() <= 0:
        return []
    thresh = max(rms.max() * 0.06, 1e-4)
    loud = rms > thresh
    gap = max(1, int(GAP_SECONDS / FRAME_SECONDS))

    segments = []
    i = 0
    while i < n:
        if not loud[i]:
            i += 1
            continue
        j = i
        last_loud = i
        while j < n and (loud[j] or j - last_loud <= gap):
            if loud[j]:
                last_loud = j
            j += 1
        start = i * frame
        end = min(len(x), (last_loud + 1) * frame)
        if end - start > sr * 0.12:  # 太短的丢掉
            segments.append((start, end))
        i = j
    return segments


def estimate_f0(x: np.ndarray, sr: int, fmin: float = 65.0, fmax: float = 420.0) -> float:
    """自相关 + 抛物线插值测基频。"""
    seg = x[: int(sr * 0.35)]
    if len(seg) < 512:
        return 0.0
    seg = seg - seg.mean()
    seg = seg * np.hanning(len(seg))
    n = len(seg)
    spec = np.fft.rfft(seg, 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    if ac[0] <= 0:
        return 0.0
    ac = ac / ac[0]
    lag_min = max(2, int(sr / fmax))
    lag_max = min(n - 2, int(sr / fmin))
    if lag_max <= lag_min:
        return 0.0
    k = int(np.argmax(ac[lag_min:lag_max])) + lag_min
    if 0 < k < n - 1:
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        denom = a - 2 * b + c
        if denom != 0:
            k = k + 0.5 * (a - c) / denom
    return float(sr / k) if k > 0 else 0.0


def detrend_low(x: np.ndarray, sr: int, win_s: float = 0.02) -> np.ndarray:
    """去掉直流和低频轰鸣（用一个滑动均值当粗糙高通）。

    作者录音里 pp（极弱奏）那几条有明显的地震级低频，最强谱峰落在 55Hz 以下，
    会把真正的音符盖掉。分析前和写出前都过一遍。
    """
    win = max(3, int(sr * win_s))
    if len(x) < win * 2:
        return x - float(np.mean(x)) if len(x) else x
    c = np.cumsum(np.concatenate(([0.0], x.astype(np.float64))))
    half = win // 2
    mov = np.empty(len(x), dtype=np.float64)
    idx = np.arange(len(x))
    lo = np.maximum(0, idx - half)
    hi = np.minimum(len(x), idx + half + 1)
    mov = (c[hi] - c[lo]) / (hi - lo)
    return (x - mov).astype(np.float32)


def spectral_peaks(
    x: np.ndarray, sr: int, fmin: float = 55.0, fmax: float = 1200.0, n_peaks: int = 6
) -> list[tuple[float, float]]:
    """返回 [(频率, 相对幅度)]，只看 fmin~fmax 这一段（躲开低频轰鸣）。"""
    seg = x[: int(sr * 0.5)]
    if len(seg) < 256:
        return []
    seg = (seg - seg.mean()) * np.hanning(len(seg))
    pad = 8 * len(seg)
    mag = np.abs(np.fft.rfft(seg, pad))
    freqs = np.fft.rfftfreq(pad, 1.0 / sr)
    lo = int(np.searchsorted(freqs, fmin))
    hi = int(np.searchsorted(freqs, fmax))
    if hi - lo < 3:
        return []
    band = mag[lo:hi]
    if band.max() <= 0:
        return []
    peaks = []
    for i in range(1, len(band) - 1):
        if band[i] > band[i - 1] and band[i] >= band[i + 1]:
            peaks.append((float(freqs[lo + i]), float(band[i])))
    peaks.sort(key=lambda p: -p[1])
    return peaks[:n_peaks]


def harmonic_support(x: np.ndarray, sr: int, f0: float, n_harm: int = 4) -> tuple[float, float]:
    """在频谱上确认 f0 真的存在（防自相关把高音认成低八度、或把噪声认成音）。

    低音弦的基频常常很弱、二次泛音最强，所以看 f0, 2f0, 3f0, 4f0 里最强的那一个。
    返回 (最强的那个谐波相对能量, 该段最强谱峰的频率)。
    """
    peaks = spectral_peaks(x, sr)
    if not peaks:
        return 0.0, 0.0
    strongest_hz, max_mag = peaks[0]
    if max_mag <= 0:
        return 0.0, 0.0

    seg = x[: int(sr * 0.5)]
    if len(seg) < 256:
        return 0.0, strongest_hz
    seg = (seg - seg.mean()) * np.hanning(len(seg))
    pad = 8 * len(seg)
    mag = np.abs(np.fft.rfft(seg, pad))
    freqs = np.fft.rfftfreq(pad, 1.0 / sr)

    def energy_near(f: float) -> float:
        if f <= 0:
            return 0.0
        k = int(np.searchsorted(freqs, f))
        lo, hi = max(0, k - 2), min(len(mag), k + 3)
        return float(mag[lo:hi].max()) if hi > lo else 0.0

    best = max(energy_near(f0 * h) / max_mag for h in range(1, n_harm + 1))
    return best, strongest_hz


def spectral_energy_ratio(x: np.ndarray, sr: int, f: float) -> float:
    """频率 f 附近的谱能量 相对 该段最强谱峰 的比值。

    这是判断"基频到底存不存在"的关键：低音弦的基频可能只有峰值的 5%，
    但一定存在；而自相关把 B3(247Hz) 认成 122Hz 时，122Hz 那里几乎是空的。
    """
    seg = x[: int(sr * 0.5)]
    if len(seg) < 256:
        return 0.0
    seg = (seg - seg.mean()) * np.hanning(len(seg))
    pad = 8 * len(seg)
    mag = np.abs(np.fft.rfft(seg, pad))
    freqs = np.fft.rfftfreq(pad, 1.0 / sr)
    lo_band = int(np.searchsorted(freqs, 55.0))
    hi = int(np.searchsorted(freqs, 1200.0))
    if hi - lo_band < 2 or mag[lo_band:hi].max() <= 0:
        return 0.0
    max_mag = float(mag[lo_band:hi].max())
    k = int(np.searchsorted(freqs, f))
    lo, hi2 = max(0, k - 2), min(len(mag), k + 3)
    if hi2 <= lo:
        return 0.0
    return float(mag[lo:hi2].max()) / max_mag


def estimate_f0_robust(x: np.ndarray, sr: int, fmin: float = 60.0, fmax: float = 420.0) -> float:
    """自相关 + 八度纠错：基频在频谱里不存在时，翻一倍再看。"""
    hz = estimate_f0(x, sr, fmin, fmax)
    if hz <= 0:
        return 0.0
    for _ in range(3):
        if spectral_energy_ratio(x, sr, hz) >= 0.02 or hz * 2 > fmax:
            break
        hz *= 2
    return hz


def resample_to_pitch(x: np.ndarray, sr: int, from_hz: float, to_hz: float) -> np.ndarray:
    """重采样把音高挪到目标频率（顺便校正原录音那点偏低）。

    重采样会同时改变时长，这正是真实移调的行为，长度变化 ~2% 无所谓。
    """
    if from_hz <= 0 or abs(to_hz - from_hz) / from_hz < 1e-4:
        return x
    ratio = to_hz / from_hz
    n_new = max(64, int(round(len(x) / ratio)))
    idx = np.arange(n_new, dtype=np.float64) * ratio
    return np.interp(idx, np.arange(len(x), dtype=np.float64), x).astype(np.float32)


def band_rms(x: np.ndarray, sr: int, t0: float, t1: float) -> float:
    a = max(0, int(t0 * sr))
    b = min(len(x), int(t1 * sr))
    if b <= a:
        return 0.0
    return float(np.sqrt((x[a:b] ** 2).mean()))


def sustain_db(x: np.ndarray, sr: int, start: int) -> float:
    """余音指标：0.45~0.65s 处相对 0.03~0.15s 处的电平（dB，负数）。

    这是唯一能抓出"被闷掉的短音"的指标 —— 那种音音高对、峰值对、时长也可能够，
    但 250ms 就掉 15dB，弹起来是"嗒"一声。
    """
    seg = x[start:]
    atk = band_rms(seg, sr, *SUSTAIN_ATTACK)
    late = band_rms(seg, sr, *SUSTAIN_LATER)
    if atk <= 0 or late <= 0:
        return -120.0
    return float(20.0 * np.log10(late / atk))


def prepare_note(x: np.ndarray, sr: int, start: int, end: int, next_start: int | None = None) -> np.ndarray:
    """裁长度、归一化、淡出。

    **长度按"起音点 + 固定时长"取，不按切段得到的 end 取。**
    以前写的是 `min(end + 0.4s, start + 2.6s)`，而切段用 6% 峰值当静音阈值，
    于是余音衰减快的音（空 A 弦那条尤其明显）被硬生生切成 0.6 秒 —— 这就是
    "5 弦跟其它五根完全不一样"的直接原因。现在只要不撞上下一个音的起音点，
    就老老实实留满 2.6 秒，尾巴那点房间声比"音被掐断"强得多。
    """
    keep = int(sr * KEEP_SECONDS)
    hard_end = len(x)
    if next_start is not None and next_start > start:
        hard_end = min(hard_end, next_start - int(sr * 0.15))
    seg = x[start : min(hard_end, start + keep)].astype(np.float32).copy()
    if len(seg) < 64:
        return seg
    seg = detrend_low(seg, sr)
    peak = float(np.max(np.abs(seg)))
    if peak > 0:
        seg *= PEAK_TARGET / peak
    fade = min(int(sr * FADE_SECONDS), len(seg) // 3)
    if fade > 0:
        seg[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return seg


def write_wav(path: str, x: np.ndarray, sr: int) -> None:
    data = np.clip(x, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# --------------------------------------------------------------------------
def choose_candidate(inventory: dict, dyn: str, s: dict, canon: str) -> dict | None:
    """在某个力度层里，为这个空弦音挑一条录音。

    规则顺序很重要，写反了就会"选到别的音"：
      1. 先用文件名的音域圈定物理上可能录到这个音的文件
         （防止自相关把高音认成低八度，比如 sulB.C4B4 里绝不会出现 110Hz 的 A2）；
      2. **音准第一**：只保留离目标音最近的 ±NEAR_CENTS 之内的候选 —— 也就是"确实是这个音"。
         这一步不能省：Iowa 这套录音**整体偏低约 1.7%（-29 音分）**，
         而同一个文件里是半音阶排列（E2 F2 F#2 ...），相邻半音在数值上也"只差 6-7%"，
         要是先按余音挑，就会把 G#2 当成 A2（我第一版就是这么错的）；
      3. 在"确实是这个音"的候选里，再按余音挑耐听的；
      4. 首选"本弦空弦那一条"（音色最正），但它不能比最耐听的差 3dB 以上。
    """
    pool = []
    for c in inventory.get(dyn, []):
        rng = file_pitch_range(c["src"])
        if rng and rng[0] * 0.97 <= s["hz"] <= rng[1] * 1.05:
            pool.append(c)
    if not pool:
        return None
    for c in pool:
        c["err_cents"] = 1200.0 * math.log2(c["hz"] / s["hz"])
    closest = min(pool, key=lambda c: abs(c["err_cents"]))
    near = [c for c in pool if abs(c["err_cents"]) <= abs(closest["err_cents"]) + NEAR_CENTS]
    # 余音合格优先，一条都没有就退而求其次（总比没有强）
    good = [c for c in near if c["sus_db"] >= SUSTAIN_MIN_DB] or near
    best_sus = max(good, key=lambda c: c["sus_db"])
    canon_c = next((c for c in good if canon in c["src"]), None)
    if canon_c is not None and canon_c["sus_db"] >= best_sus["sus_db"] - CANON_MARGIN_DB:
        return canon_c
    return best_sus


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default=os.path.join(ROOT, "incoming", "Guitar.mono.1644.1.zip"))
    args = ap.parse_args()

    if not os.path.exists(args.zip):
        raise SystemExit(f"找不到采样包：{args.zip}\n请先下载 Guitar.mono.1644.1.zip 放进 incoming/")

    os.makedirs(OUT_DIR, exist_ok=True)
    zf = zipfile.ZipFile(args.zip)
    aifs = [
        n
        for n in zf.namelist()
        if n.lower().endswith(".aif") and not n.startswith("__MACOSX") and not os.path.basename(n).startswith("._")
    ]
    print(f"压缩包里 {len(aifs)} 个 aif")

    # 先把所有段落的音高量出来，建立 动态 -> [(hz, sr, 波形)] 清单
    inventory: dict[str, list[dict]] = {d: [] for d in DYNAMICS}
    for name in sorted(aifs):
        base = os.path.basename(name)
        parts = base.split(".")
        dyn = parts[1] if len(parts) > 1 else "?"
        if dyn not in inventory:
            continue
        try:
            x, sr = read_aiff(zf.read(name))
        except Exception as exc:  # noqa: BLE001
            print(f"  跳过 {base}: {exc}")
            continue
        x = detrend_low(x, sr)
        segs = find_segments(x, sr)
        kept = 0
        for idx, (s, e) in enumerate(segs, start=1):
            piece = x[s:e]
            # 只要"像个音"的段：别太短，且最强谱峰落在乐音范围内。
            # 不滤的话会把作者文件空隙里那些 2~9Hz 的漂移噪声当成音符。
            if len(piece) < sr * 0.2:
                continue
            peaks = spectral_peaks(piece, sr, n_peaks=3)
            if not peaks or not (55.0 <= peaks[0][0] <= 1000.0):
                continue
            hz = estimate_f0_robust(piece, sr)
            if not (60.0 <= hz <= 420.0):
                continue
            # 基频必须在频谱里真的存在（低音弦弱到 5% 也算存在）
            fund = spectral_energy_ratio(piece, sr, hz)
            if fund < 0.02:
                continue
            support, strongest = harmonic_support(piece, sr, hz)
            if support < 0.10:
                continue
            kept += 1
            inventory[dyn].append(
                {
                    "src": base,
                    "seq": idx,
                    "start": s,
                    "end": e,
                    "next": segs[idx][0] if idx < len(segs) else None,
                    "hz": hz,
                    "fund": fund,
                    "support": support,
                    "strongest": strongest,
                    "sus_db": sustain_db(x, sr, s),
                    "sr": sr,
                    "x": x,
                }
            )
        print(f"  {dyn:>2} {base:<38} 切出 {len(segs)} 段，其中像音符的 {kept} 个")

    manifest = []
    print("\n=== 选音（限定来源文件 + 谐波复核 + 余音筛短音 + 校正到标准音高）===")
    print(
        f"{'':4} {'层':>3} {'弦':>4} {'音':>3} {'目标Hz':>8} {'原录音Hz':>9} {'原偏差':>7} "
        f"{'谐波支撑':>8} {'余音dB':>7} {'重采样后Hz':>10} {'剩余偏差':>8}  来源"
    )
    ok_all = True
    for d in DYNAMICS:
        if not inventory[d]:
            continue
        layer_dir = os.path.join(OUT_DIR, d)
        os.makedirs(layer_dir, exist_ok=True)
        for s in OPEN_STRINGS:
            canon = CANONICAL_SOURCE[s["note"]]
            best = choose_candidate(inventory, d, s, canon)
            borrowed = None
            # 本层这条明显短（低于 SUSTAIN_GOOD_DB），而别的力度层里同音明显更耐听时，
            # 借过来用 —— 层与层之间只差演奏力度、音高一样，
            # 宁可音色稍异，也不要一根弦"嗒"一声就没了（用户就是这么听出 5 弦不对的）。
            if best is not None and best["sus_db"] < SUSTAIN_GOOD_DB:
                alts = []
                for other in DYNAMICS:
                    if other == d:
                        continue
                    c = choose_candidate(inventory, other, s, canon)
                    if c is not None:
                        alts.append((other, c))
                if alts:
                    other, c = max(alts, key=lambda t: t[1]["sus_db"])
                    if c["sus_db"] > best["sus_db"] + BORROW_MARGIN_DB:
                        best, borrowed = c, other
            if best is None:
                print(f"[!!] {d} {s['name']} {s['note']}: 没有任何文件录了这个音")
                ok_all = False
                continue
            raw_err = abs(best["hz"] - s["hz"]) / s["hz"]
            if raw_err > CORRECT_TOLERANCE:
                print(f"[!!] {d} {s['name']} {s['note']}: 最近的一段也差 {raw_err * 100:.2f}%，放弃")
                ok_all = False
                continue

            seg = prepare_note(best["x"], best["sr"], best["start"], best["end"], best.get("next"))
            # 原录音整体偏低 ~1-2%，重采样校正到标准音高
            seg = resample_to_pitch(seg, best["sr"], best["hz"], s["hz"])

            fname = f"{s['note']}.wav"
            out_path = os.path.join(layer_dir, fname)
            write_wav(out_path, seg, best["sr"])

            # 独立复测：把刚写出的文件重新读回来量一次基频 + 余音
            with wave.open(out_path, "rb") as w:
                sr_out = w.getframerate()
                back = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            final_hz = estimate_f0_robust(back, sr_out)
            final_support, _ = harmonic_support(back, sr_out, final_hz)
            final_err = abs(final_hz - s["hz"]) / s["hz"] if final_hz > 0 else 1.0
            final_sus = sustain_db(back, sr_out, 0)
            good = final_err <= VERIFY_TOLERANCE and final_support >= 0.10 and final_sus >= SUSTAIN_MIN_DB
            if not good:
                ok_all = False
            print(
                f"{'[OK]' if good else '[!!]':4} {d:>3} {s['name']:>4} {s['note']:>3} "
                f"{s['hz']:8.2f} {best['hz']:9.2f} {raw_err * 100:6.2f}% {best['support']:8.3f} "
                f"{final_sus:7.1f} {final_hz:10.2f} {final_err * 100:7.2f}%  {best['src']} #{best['seq']}"
                + (f"  ← 借自 {borrowed}" if borrowed else "")
            )
            manifest.append(
                {
                    "string": s["index"],
                    "note": s["note"],
                    "targetHz": round(s["hz"], 2),
                    "recordedHz": round(best["hz"], 2),
                    "measuredHz": round(final_hz, 2),
                    "sustainDb": round(final_sus, 1),
                    "borrowedFrom": borrowed,
                    "dynamic": d,
                    "file": f"{d}/{fname}",
                    "seconds": round(len(seg) / best["sr"], 2),
                    "source": f"{best['src']} #{best['seq']}",
                    "harmonicSupport": round(best["support"], 3),
                    "pitchCorrected": True,
                }
            )

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "source": "University of Iowa Musical Instrument Samples (MIS), Guitar, mono 16bit/44.1k",
                "sourceUrl": "https://theremin.music.uiowa.edu/MISguitar.html",
                "license": "免费使用，需署名 University of Iowa Electronic Music Studios",
                "openStrings": [{"index": s["index"], "note": s["note"], "hz": s["hz"]} for s in OPEN_STRINGS],
                "samples": manifest,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    total = sum(os.path.getsize(os.path.join(OUT_DIR, m["file"])) for m in manifest)
    print(f"\n写出 {len(manifest)} 个 wav，共 {total / 1024 / 1024:.2f} MB -> {OUT_DIR}")
    if not ok_all:
        raise SystemExit("有音的基频对不上目标，请检查")


if __name__ == "__main__":
    main()
