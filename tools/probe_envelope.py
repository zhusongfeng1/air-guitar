"""打印一个源 aif 的整条 RMS 包络（不是切段结果），看真实的音长和底噪。

    python tools/probe_envelope.py Guitar.ff.sulA.A2B2.aif [桶秒数]

用来判断"音本来就短"还是"我的切段阈值把它切短了"：
把噪声底也画出来，就能看出阈值之上的能量到底持续多久。
"""

from __future__ import annotations

import os
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_guitar_samples import ROOT, detrend_low, read_aiff  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("用法：python tools/probe_envelope.py <文件名片段> [桶秒数]")
    probe = sys.argv[1]
    bucket = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25
    zip_path = os.path.join(ROOT, "incoming", "Guitar.mono.1644.1.zip")
    zf = zipfile.ZipFile(zip_path)
    names = [
        n
        for n in zf.namelist()
        if n.lower().endswith(".aif") and not n.startswith("__MACOSX") and not os.path.basename(n).startswith("._")
    ]
    for name in sorted(n for n in names if probe in n):
        x, sr = read_aiff(zf.read(name))
        x = detrend_low(x, sr)
        n = int(len(x) / sr / bucket)
        peak = float(np.max(np.abs(x)))
        print(f"\n=== {os.path.basename(name)}  {len(x) / sr:.1f}s  峰值 {peak:.3f}  "
              f"桶 {bucket}s  横轴单位 dB（相对峰值）===")
        for i in range(n):
            a = int(i * bucket * sr)
            b = min(len(x), a + int(bucket * sr))
            seg = x[a:b]
            r = float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0
            db = 20 * np.log10(max(r, 1e-9) / max(peak, 1e-9))
            if db < -60:
                continue  # 太安静的不打印，省地方
            bar = "#" * max(0, int((db + 60) / 2))
            print(f"  {i * bucket:7.2f}s {db:7.1f}dB {bar}")


if __name__ == "__main__":
    main()
