"""把 handpose_x 仓库里的样例手图整理成网页可用的测试素材。

产出：
  web/assets/samples/*.jpg       原图（过大的会等比缩小）
  web/assets/samples/padded_*.jpg 把手裁图贴到中性背景上（提高 MediaPipe 手掌检测成功率）
  web/assets/samples/manifest.json 给网页读的清单
"""

from __future__ import annotations

import json
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HP = os.path.join(ROOT, "third_party", "handpose_x")
OUT = os.path.join(ROOT, "web", "assets", "samples")

# (源文件相对 HP 的路径, 输出名, 展示名, 是否作为默认首屏)
SOURCES = [
    ("samples/test.png", "test.png", "仓库样例 test.png", False),
    ("samples/gest.jpg", "gest.jpg", "手势样例 gest.jpg", False),
    ("image/image_2021-02-04_20-05-49.jpg", "img_0549.jpg", "样例图 05-49", False),
    ("image/image_2021-02-04_20-06-03.jpg", "img_0603.jpg", "样例图 06-03", False),
    ("image/image_2021-02-04_20-06-04.jpg", "img_0604.jpg", "样例图 06-04", False),
    ("image/image_2021-02-04_20-06-05.jpg", "img_0605.jpg", "样例图 06-05", False),
    ("image/image_2021-02-04_20-06-13.jpg", "img_0613.jpg", "样例图 06-13", False),
]

# 需要额外做"贴到背景上"的紧裁剪图：MediaPipe 的手掌检测器需要完整场景，
# 所以把手裁图缩小、旋转、贴到大画布上，模拟真实摄像头画面。
# (源文件, 输出名, 展示名, 缩放到画布高度的比例, 旋转角度, 背景色)
PAD_SOURCES = [
    ("handpose_datasets/2021-02-01_13-52-53_532.jpg", "padded_hand_a.jpg", "合成场景 A", 0.45, -18, (196, 198, 194)),    ("handpose_datasets/2021-02-01_13-52-49_284.jpg", "padded_hand_b.jpg", "合成场景 B", 0.55, 0, (176, 180, 186)),
    ("handpose_datasets/2021-02-01_13-52-55_721.jpg", "padded_hand_c.jpg", "合成场景 C", 0.50, 14, (208, 202, 190)),
    ("image/image_2021-02-04_20-06-03.jpg", "padded_hand_d.jpg", "合成场景 D", 0.42, -10, (188, 190, 186)),
    ("image/image_2021-02-04_20-06-05.jpg", "padded_hand_e.jpg", "合成场景 E", 0.58, 8, (170, 176, 172)),
    ("image/image_2021-02-04_20-06-13.jpg", "padded_hand_f.jpg", "合成场景 F", 0.48, -25, (200, 196, 188)),
]

PAD_SIZE = (960, 720)


def save_max(img: Image.Image, path: str, max_side: int = 900) -> None:
    if max(img.size) > max_side:
        ratio = max_side / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)
    img.convert("RGB").save(path, quality=92)


def pad_onto_background(src_path: str, dst_path: str, scale: float, angle: float, bg_color) -> None:
    hand = Image.open(src_path).convert("RGB")
    target_h = int(PAD_SIZE[1] * scale)
    ratio = target_h / hand.height
    hand = hand.resize((max(1, int(hand.width * ratio)), target_h), Image.LANCZOS)
    if angle:
        hand = hand.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=bg_color)

    bg = Image.new("RGB", PAD_SIZE, bg_color)
    # 稍微随机化位置，避免每张都贴在正中心
    import random

    rnd = random.Random(hash(dst_path) & 0xFFFF)
    x = (PAD_SIZE[0] - hand.width) // 2 + rnd.randint(-60, 60)
    y = (PAD_SIZE[1] - hand.height) // 2 + rnd.randint(-40, 40)
    bg.paste(hand, (x, y))
    bg.save(dst_path, quality=92)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    manifest = []

    for rel, out_name, label, is_default in SOURCES:
        src = os.path.join(HP, rel)
        if not os.path.exists(src):
            print("跳过（不存在）", rel)
            continue
        save_max(Image.open(src), os.path.join(OUT, out_name))
        manifest.append({"file": out_name, "label": label, "default": is_default})
        print("复制", rel, "->", out_name)

    for rel, out_name, label, scale, angle, bg_color in PAD_SOURCES:
        src = os.path.join(HP, rel)
        if not os.path.exists(src):
            print("跳过（不存在）", rel)
            continue
        pad_onto_background(src, os.path.join(OUT, out_name), scale, angle, bg_color)
        manifest.append({"file": out_name, "label": label, "default": False})
        print("合成", rel, "->", out_name)

    # 默认首屏用合成场景（紧裁剪的原图 MediaPipe 常常认不出来）
    for item in manifest:
        item["default"] = item["file"] == "padded_hand_a.jpg"

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n共 {len(manifest)} 张 -> {OUT}")


if __name__ == "__main__":
    main()
