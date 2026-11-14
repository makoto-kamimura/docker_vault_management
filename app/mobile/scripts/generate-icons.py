#!/usr/bin/env python3
"""Draws the うちカギ app icons (assets/icon.png, assets/adaptive-icon.png) with Pillow.

The geometry and colours mirror `brand` / `brandMark` in app/packages/design-tokens/src/tokens.ts
(keep both in sync). Usage, from app/mobile: python3 scripts/generate-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

AI = (0x1F, 0x4A, 0x86, 255)  # 藍
BRASS = (0xE2, 0xBC, 0x6E, 255)  # 真鍮

GRID = 1024
BOW = [512, 212, 748, 420, 690, 420, 690, 630, 334, 630, 334, 420, 276, 420]
KEYHOLE_CIRCLE = (512, 490, 46)
KEYHOLE_STEM = [490, 520, 534, 520, 548, 590, 476, 590]
BARS = [(484, 628, 56, 222), (538, 740, 78, 42), (538, 800, 58, 42)]

SUPERSAMPLE = 4
ASSETS = Path(__file__).resolve().parent.parent / "assets"


def draw_mark(size: int, mark_scale: float) -> Image.Image:
    """Full-bleed 藍 square with the mark scaled to `mark_scale` of the canvas, centred."""
    big = size * SUPERSAMPLE
    img = Image.new("RGBA", (big, big), AI)
    d = ImageDraw.Draw(img)
    k = big * mark_scale / GRID
    off = (big - GRID * k) / 2

    def pts(xs):
        return [(off + xs[i] * k, off + xs[i + 1] * k) for i in range(0, len(xs), 2)]

    d.polygon(pts(BOW), fill=BRASS)
    cx, cy, r = KEYHOLE_CIRCLE
    d.ellipse(
        [off + (cx - r) * k, off + (cy - r) * k, off + (cx + r) * k, off + (cy + r) * k], fill=AI
    )
    d.polygon(pts(KEYHOLE_STEM), fill=AI)
    for x, y, w, h in BARS:
        d.rectangle([off + x * k, off + y * k, off + (x + w) * k - 1, off + (y + h) * k - 1], fill=BRASS)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    # iOS masks the corners itself; the mark fills the canvas as designed.
    draw_mark(1024, 1.0).save(ASSETS / "icon.png")
    # Android adaptive icon: keep the mark inside the central safe zone (~66%).
    draw_mark(512, 0.62).save(ASSETS / "adaptive-icon.png")
    print("wrote", ASSETS / "icon.png", "and", ASSETS / "adaptive-icon.png")
