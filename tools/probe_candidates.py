"""在采样包里找某个音的**所有**录音，按"余音好不好"排序。

    python tools/probe_candidates.py A2 [--cents 45]

为什么要它：Iowa 这套录音是按"弦 + 音域段"给的，同一个音常常在多条不同弦上录过，
但**有些条的演奏是被闷掉的短音**（空 A 弦那条 A2 就是：250ms 掉 15dB 然后停在 -36dB）。
光看文件名挑不出来，必须量衰减曲线。

判定标准不是"有多响"，而是**衰减是否自然**：
  持续度 = RMS(0.45~0.65s) / RMS(0.03~0.15s)
正常的拨弦低音弦在 0.5s 处还有 -5~-15dB；被闷掉的音会掉到 -25dB 以下。
"""

from __future__ import annotations

import argparse
import os
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_guitar_samples import (  # noqa: E402
    ROOT,
    detrend_low,
    estimate_f0_robust,
    find_segments,
    note_to_hz,
    read_aiff,
    spectral_peaks,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def band_rms(x: np.ndarray, sr: int, t0: float, t1: float) -> float:
    a = int(t0 * sr)
    b = min(len(x), int(t1 * sr))
    if b <= a:
        return 0.0
    return float(np.sqrt((x[a:b] ** 2).mean()))


def db(a: float, b: float) -> float:
    if b <= 0 or a <= 0:
        return -120.0
    return 20 * np.log10(a / b)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("note", help="目标音名，例如 A2 / E2 / G3")
    ap.add_argument("--cents", type=float, default=45.0, help="允许偏差（音分）")
    args = ap.parse_args()

    target = note_to_hz(args.note)
    zip_path = os.path.join(ROOT, "incoming", "Guitar.mono.1644.1.zip")
    zf = zipfile.ZipFile(zip_path)
    names = [
        n
        for n in zf.namelist()
        if n.lower().endswith(".aif") and not n.startswith("__MACOSX") and not os.path.basename(n).startswith("._")
    ]
    hits = []
    for name in sorted(names):
        base = os.path.basename(name)
        try:
            x, sr = read_aiff(zf.read(name))
        except Exception as exc:  # noqa: BLE001
            print(f"  跳过 {base}: {exc}")
            continue
        x = detrend_low(x, sr)
        segs = find_segments(x, sr)
        for idx, (s, e) in enumerate(segs, start=1):
            piece = x[s:e]
            if len(piece) < sr * 0.2:
                continue
            peaks = spectral_peaks(piece, sr, n_peaks=3)
            if not peaks or not (55.0 <= peaks[0][0] <= 1000.0):
                continue
            hz = estimate_f0_robust(piece, sr)
            if hz <= 0:
                continue
            cents = 1200 * np.log2(hz / target)
            if abs(cents) > args.cents:
                continue
            note = x[s:]
            atk = band_rms(note, sr, 0.03, 0.15)
            sus = band_rms(note, sr, 0.45, 0.65)
            late = band_rms(note, sr, 1.0, 1.3)
            hits.append({"src": base, "seq": idx, "start": s / sr, "hz": float(hz), "cents": float(cents),
                         "atk": atk, "sus": sus, "late": late,
                         "sus_db": db(sus, atk), "late_db": db(late, atk)})

    hits.sort(key=lambda h: -h["sus_db"])
    print(f"\n=== 全部落在 {args.note}（{target:.2f}Hz）±{args.cents:.0f} 音分的录音段，按余音排序 ===")
    print(f"{'文件':<32} {'#':>2} {'起点':>7} {'实测Hz':>8} {'偏差':>7} {'0.5s处':>8} {'1.2s处':>8}")
    for h in hits:
        print(f"{h['src']:<32} {h['seq']:>2} {h['start']:7.2f} {h['hz']:8.2f} "
              f"{h['cents']:+7.1f} {h['sus_db']:+8.1f} {h['late_db']:+8.1f}")
    if hits:
        best = hits[0]
        print(f"\n余音最好的是 {best['src']} #{best['seq']}（0.5s 处 {best['sus_db']:+.1f}dB，"
              f"1.2s 处 {best['late_db']:+.1f}dB，偏差 {best['cents']:+.1f} 音分）")
        print("参考：正常拨弦低音弦 0.5s 处大约 -3 ~ -12dB；低于 -20dB 基本就是被闷掉的短音。")
    else:
        print("\n没找到（放宽 --cents 试试）")


if __name__ == "__main__":
    main()
