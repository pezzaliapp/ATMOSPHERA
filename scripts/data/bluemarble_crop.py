"""
Ritaglia la NASA Blue Marble: Next Generation (topografia + batimetria, 21600×10800,
1/60° per pixel) sulla regione dell'evento.

Uso:
  scripts/data/.venv/bin/python -I scripts/data/bluemarble_crop.py \
      --src data-raw/nasa/bm-200410-21600.jpg --out public/data/events/milton-2024/surface.jpg
"""

import argparse
from pathlib import Path

from PIL import Image

# Immagine NASA di fonte nota: oltre la soglia anti "decompression bomb" di Pillow.
Image.MAX_IMAGE_PIXELS = None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bounds", type=float, nargs=4, default=[-100.0, 16.0, -68.0, 36.0], metavar=("W", "S", "E", "N"))
    args = ap.parse_args()

    img = Image.open(args.src)
    px_per_deg = img.width / 360
    assert abs(img.height / 180 - px_per_deg) < 1e-9, "atteso un planisfero equirettangolare 2:1"
    west, south, east, north = args.bounds
    box = (
        round((west + 180) * px_per_deg),
        round((90 - north) * px_per_deg),
        round((east + 180) * px_per_deg),
        round((90 - south) * px_per_deg),
    )
    crop = img.crop(box)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(args.out, quality=86, optimize=True, progressive=True)
    print(f"{args.out}: {crop.width}×{crop.height} da {box}")


if __name__ == "__main__":
    main()
