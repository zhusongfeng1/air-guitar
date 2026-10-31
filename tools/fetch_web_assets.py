"""把网页运行时需要的 wasm / 模型抓到本地，避免依赖 CDN。

用法（在本目录的上一级或任意位置执行）：
    python tools/fetch_web_assets.py            # 抓全部
    python tools/fetch_web_assets.py --only ort # 只抓某一份

抓取内容：
  web/vendor/mediapipe/   @mediapipe/tasks-vision 的 JS + wasm
  web/vendor/ort/         onnxruntime-web 的 JS + wasm
  web/vendor/models/      hand_landmarker.task（MediaPipe 手部关键点，7~8MB）

handpose_x 的 resnet50.onnx 需要你从百度网盘手动获取，见 docs/权重获取清单.md。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tarfile
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "web", "vendor")

NPM_REGISTRIES = (
    "https://registry.npmmirror.com",
    "https://registry.npmjs.org",
)

# MediaPipe 官方模型（可能有多个镜像，按顺序尝试）
HAND_LANDMARKER_URLS = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task",
    "https://cdn.jsdelivr.net/gh/googlesamples/mediapipe@main/examples/"
    "hand_landmarker/js/hand_landmarker.task",
)


def log(*a) -> None:
    print(*a, flush=True)


def fetch(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 dsh-agent"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def latest_version(pkg: str) -> tuple[str, str]:
    """返回 (版本号, tarball 地址)。"""
    last_err: Exception | None = None
    for reg in NPM_REGISTRIES:
        try:
            meta = json.loads(fetch(f"{reg}/{pkg}", timeout=120))
            ver = meta["dist-tags"]["latest"]
            return ver, meta["versions"][ver]["dist"]["tarball"]
        except Exception as e:  # noqa: BLE001
            last_err = e
            log(f"   镜像不可用 {reg}: {type(e).__name__} {e}")
    raise RuntimeError(f"取不到 {pkg} 的版本信息") from last_err


def extract_tgz(data: bytes, dest: str, strip_prefix: str = "package/") -> int:
    os.makedirs(dest, exist_ok=True)
    n = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            name = m.name
            if strip_prefix and name.startswith(strip_prefix):
                name = name[len(strip_prefix):]
            target = os.path.join(dest, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            with open(target, "wb") as out:
                out.write(f.read())
            n += 1
    return n


def grab_npm(pkg: str, dest_rel: str) -> None:
    ver, tarball = latest_version(pkg)
    dest = os.path.join(VENDOR, dest_rel)
    log(f"[{pkg}] {ver}")
    log(f"   {tarball}")
    data = fetch(tarball)
    log(f"   下载 {len(data)/1048576:.1f} MB")
    n = extract_tgz(data, dest)
    log(f"   解出 {n} 个文件 -> {dest}")


def grab_hand_landmarker() -> None:
    dest_dir = os.path.join(VENDOR, "models")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "hand_landmarker.task")
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
        log(f"[model] 已存在，跳过 {dest}")
        return
    for url in HAND_LANDMARKER_URLS:
        try:
            log(f"[model] {url}")
            data = fetch(url)
            if len(data) < 1_000_000:
                log(f"   太小({len(data)}B)，判定不是模型，换下一个")
                continue
            with open(dest, "wb") as f:
                f.write(data)
            log(f"   OK {len(data)/1048576:.1f} MB -> {dest}")
            return
        except Exception as e:  # noqa: BLE001
            log(f"   失败 {type(e).__name__}: {e}")
    log("[model] 全部镜像失败：请手动下载 hand_landmarker.task 放进 web/vendor/models/")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["mediapipe", "ort", "model"], default=None)
    args = ap.parse_args()

    todo = args.only
    try:
        if todo in (None, "mediapipe"):
            grab_npm("@mediapipe/tasks-vision", "mediapipe")
        if todo in (None, "ort"):
            grab_npm("onnxruntime-web", "ort")
        if todo in (None, "model"):
            grab_hand_landmarker()
    except Exception as e:  # noqa: BLE001
        log(f"失败: {type(e).__name__}: {e}")
        return 1
    log("完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
