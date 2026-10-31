"""把一个源 aif 里的所有发声段列出来：每段的起止、时长、RMS 包络、测出的音高。

用来回答"这个音在源文件里本来就这么短，还是我裁短了"。

    python tools/probe_segments.py                      # 默认看 A2 的三个力度
    python tools/probe_segments.py sulA.A2B2            # 看名字里含这个串的文件
"""

from __future__ import annotations

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
    read_aiff,
)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

PROBES = sys.argv[1:] or ["sulA.A2B2", "sulE.E2B2", "sulD.D3B3"]


def rms_between(x: np.ndarray, sr: int, t0: float, dur: float = 0.05) -> float:
    a = int(t0 * sr)
    b = min(len(x), a + int(dur * sr))
    if b <= a:
        return 0.0
    return float(np.sqrt((x[a:b] ** 2).mean()))


def main() -> None:
    zip_path = os.path.join(ROOT, "incoming", "Guitar.mono.1644.1.zip")
    if not os.path.exists(zip_path):
        raise SystemExit(f"找不到 {zip_path}")
    zf = zipfile.ZipFile(zip_path)
    names = [
        n
        for n in zf.namelist()
        if n.lower().endswith(".aif") and not n.startswith("__MACOSX") and not os.path.basename(n).startswith("._")
    ]
    for probe in PROBES:
        hits = [n for n in names if probe in n]
        for name in sorted(hits):
            base = os.path.basename(name)
            x, sr = read_aiff(zf.read(name))
            raw_len = len(x) / sr
            x = detrend_low(x, sr)
            segs = find_segments(x, sr)
            print(f"\n=== {base}  原始时长 {raw_len:.2f}s  切出 {len(segs)} 段 ===")
            print(f"{'#':>2} {'起点':>7} {'终点':>7} {'时长':>6} {'峰值':>7} "
                  f"{'0.05':>6} {'0.25':>6} {'0.5':>6} {'1.0':>6} {'1.5':>6} {'2.0':>6}  音高")
            for i, (s, e) in enumerate(segs, start=1):
                piece = x[s:e]
                peak = float(np.max(np.abs(piece)))
                env = [rms_between(x, sr, s / sr + t) for t in (0.05, 0.25, 0.5, 1.0, 1.5, 2.0)]
                hz = estimate_f0_robust(piece, sr)
                print(
                    f"{i:>2} {s / sr:7.2f} {e / sr:7.2f} {(e - s) / sr:6.2f} {peak:7.3f} "
                    + " ".join(f"{v:6.3f}" for v in env)
                    + f"  {hz:7.2f}Hz"
                )
            # 全文件在最响的段之后还能响多久（相对峰值 -30dB 的位置）
            if segs:
                loudest = max(segs, key=lambda se: float(np.max(np.abs(x[se[0]:se[1]]))))
                a, b = loudest
                tail = x[b:]
                if len(tail) > sr * 0.05:
                    tr = np.sqrt(
                        np.convolve(tail.astype(np.float64) ** 2, np.ones(int(sr * 0.05)) / int(sr * 0.05), "same")
                    )
                    peak_all = float(np.max(np.abs(x)))
                    below = np.where(tr < peak_all * 0.03)[0]
                    t_below = below[0] / sr if len(below) else float("nan")
                    print(f"   段 {segs.index(loudest) + 1} 结束后，还能在 -30dB 以上响 {t_below:.2f}s")


if __name__ == "__main__":
    main()
