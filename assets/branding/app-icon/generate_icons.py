#!/usr/bin/env python3
"""Regenerate Agent Workbench app-icon PNGs + ICO from the Converge mark.

Direction A (user pick, 2026-11-13): Y-merge + orange node. This is a REFRESH
of that mark, not a new direction — the old render failed at small sizes:
- Ink tile (#1E2126) vanished on a dark Windows taskbar (zero contrast).
- Y arms (w=54/512) anti-aliased into a grey smudge at 16px.
- Orange node (r=42/512) was ~2.6px at 16px: invisible.

Fixes: Paper tile (pops on dark, hairline holds it on light), thicker Y
(72/512), bigger node (r=56/512), and a dedicated 16-grid small geometry
for 16/24/32 so the small sizes are drawn, not scaled down.

Pure PIL (no SVG renderer needed). Deterministic: same script run on the PC
reproduces byte-identical PNGs. ICO uses PNG entries (Vista+), one per size,
so Windows picks the exact hand-tuned render at each size.
"""
import io
import os
import struct
import sys
from PIL import Image, ImageDraw

PAPER = (245, 243, 238, 255)
INK = (30, 33, 38, 255)
ORANGE = (232, 93, 38, 255)
BORDER = (30, 33, 38, 26)  # ~10% ink hairline: defines the light tile on white
SS = 4  # supersample factor

MASTER = dict(
    grid=512, tile=(24, 24, 488, 488), rx=104, stroke=72,
    arms=[((148, 148), (256, 256)), ((148, 364), (256, 256)),
          ((384, 256), (256, 256))],
    node=(256, 256, 56),
)
SMALL = dict(
    grid=16, tile=(0, 0, 16, 16), rx=3.5, stroke=2.75,
    arms=[((4.5, 4.5), (8, 8)), ((4.5, 11.5), (8, 8)),
          ((12, 8), (8, 8))],
    node=(8, 8, 2.25),
)


def render(size, geo):
    sc = size * SS / geo["grid"]
    img = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = [v * sc for v in geo["tile"]]
    d.rounded_rectangle([x0, y0, x1, y1], radius=geo["rx"] * sc, fill=PAPER)
    # 1-output-px hairline border, drawn inside the tile edge
    d.rounded_rectangle([x0, y0, x1, y1], radius=geo["rx"] * sc,
                        outline=BORDER, width=SS)
    w = geo["stroke"] * sc
    for (ax, ay), (bx, by) in geo["arms"]:
        d.line([(ax * sc, ay * sc), (bx * sc, by * sc)], fill=INK,
               width=max(1, round(w)))
        for cx, cy in ((ax, ay), (bx, by)):  # round caps
            r = w / 2
            d.ellipse([cx * sc - r, cy * sc - r,
                       cx * sc + r, cy * sc + r], fill=INK)
    cx, cy, r = geo["node"]
    d.ellipse([cx * sc - r * sc, cy * sc - r * sc,
               cx * sc + r * sc, cy * sc + r * sc], fill=ORANGE)
    return img.resize((size, size), Image.LANCZOS)


def write_ico(path, images):
    """ICO with PNG entries (Vista+), exact renders per size."""
    blobs = []
    for size in sorted(images):
        buf = io.BytesIO()
        images[size].save(buf, "PNG")
        blobs.append((size, buf.getvalue()))
    count = len(blobs)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = b""
    body = b""
    for size, blob in blobs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32,
                               len(blob), offset)
        body += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + entries + body)


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    out = {}
    for s in (16, 24, 32):
        out[s] = render(s, SMALL)
    for s in (48, 128, 256, 512):
        out[s] = render(s, MASTER)
    for s, img in out.items():
        img.save(os.path.join(out_dir, "icon-%d.png" % s))
    write_ico(os.path.join(out_dir, "agent-workbench.ico"),
              {s: out[s] for s in (16, 24, 32, 48, 256)})
    print("wrote", sorted(os.listdir(out_dir)))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "out")