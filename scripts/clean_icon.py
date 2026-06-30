"""One-off: strip the baked-in checkerboard background from icon/karajan_v2.png
and export a real RGBA PNG. The source has no alpha channel at all (mode RGB) —
the "transparency" is a checkerboard pattern painted as opaque pixels.

The line art has small gaps between hair strands where the white fill is
topologically connected to the outer background, so a naive flood-fill from the
corners leaks into the face/collar. We close those gaps first (erode the
"light" mask so 1-3px gaps seal shut), flood-fill the background through the
closed mask, then dilate the result back out to the true edge before using it
as the alpha channel.
"""
from __future__ import annotations

from collections import deque

from PIL import Image, ImageFilter

SRC = "icon/karajan_v2.png"
OUT_MASTER = "icon/karajan_v2.png"
OUT_STATIC = "dashboard/static/icons/karajan_v2.png"
LIGHT_THRESHOLD = 205  # max(r,g,b) >= this => candidate background (white or checker gray)
CLOSE_RADIUS = 7  # px; must exceed the widest gap between hair strands


def _compute_light_mask(rgb: Image.Image) -> Image.Image:
    w, h = rgb.size
    px = rgb.load()
    mask = Image.new("L", (w, h), 0)
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if max(r, g, b) >= LIGHT_THRESHOLD:
                mpx[x, y] = 255
    return mask


def flood_fill_background(closed_light: Image.Image) -> Image.Image:
    w, h = closed_light.size
    px = closed_light.load()
    seen = bytearray(w * h)
    bg = Image.new("L", (w, h), 0)
    bpx = bg.load()

    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        if px[x, y] < 128:
            continue
        bpx[x, y] = 255
        if x + 1 < w and not seen[idx + 1]:
            q.append((x + 1, y))
        if x - 1 >= 0 and not seen[idx - 1]:
            q.append((x - 1, y))
        if y + 1 < h and not seen[idx + w]:
            q.append((x, y + 1))
        if y - 1 >= 0 and not seen[idx - w]:
            q.append((x, y - 1))
    return bg


def clean(img: Image.Image) -> Image.Image:
    rgb = img.convert("RGB")
    light = _compute_light_mask(rgb)
    # Close small gaps (erode then dilate) so background can't leak through hair strands.
    closed = light.filter(ImageFilter.MinFilter(CLOSE_RADIUS)).filter(ImageFilter.MaxFilter(CLOSE_RADIUS))
    bg_eroded = flood_fill_background(closed.filter(ImageFilter.MinFilter(CLOSE_RADIUS)))
    bg = bg_eroded.filter(ImageFilter.MaxFilter(CLOSE_RADIUS))
    alpha = Image.eval(bg, lambda v: 255 - v)
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.0))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def main() -> None:
    img = Image.open(SRC)
    cleaned = clean(img)
    cleaned.save(OUT_MASTER)
    cleaned.save(OUT_STATIC)
    print("alpha extrema:", cleaned.split()[-1].getextrema())


if __name__ == "__main__":
    main()
