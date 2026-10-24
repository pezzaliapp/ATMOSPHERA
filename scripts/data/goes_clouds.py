"""
Converte un'osservazione GOES-16 ABI (prodotto L2 CMIP, settore CONUS) in due texture
equirettangolari regionali per ATMOSPHERA:

  clouds-albedo.jpg  canale 2 (0,64 µm) — riflettanza normalizzata per l'angolo solare
  clouds-bt.jpg      canale 13 (10,3 µm) — temperatura di brillanza della sommità delle nubi

Entrambe sono grandezze OSSERVATE, solo riproiettate e ricampionate. L'opacità e
l'altezza delle nubi vengono derivate nel browser (vedi src/layers/clouds.ts).

Proiezione: formule della GOES-R Product User Guide (PUG), vol. 5, sez. 4.2.8.

Uso:
  scripts/data/.venv/bin/python -I scripts/data/goes_clouds.py \
      --c02 data-raw/goes16/C02.nc --c13 data-raw/goes16/C13.nc \
      --out public/data/events/milton-2024
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np
from PIL import Image

# Codifica nelle texture a 8 bit (documentata anche in meta.json).
ALBEDO_MAX = 1.0
BT_MIN, BT_MAX = 180.0, 310.0


def read_cmi(path: Path) -> tuple[np.ndarray, dict]:
    """Legge CMI decodificato (float32, NaN dove mancante) e i metadati di proiezione."""
    with h5py.File(path, "r") as f:
        cmi = f["CMI"]
        raw = cmi[...]
        scale = float(cmi.attrs["scale_factor"][0])
        offset = float(cmi.attrs["add_offset"][0])
        fill = int(cmi.attrs["_FillValue"][0])
        data = raw.astype(np.float32) * scale + offset
        data[raw == fill] = np.nan

        def axis(name: str) -> np.ndarray:
            v = f[name]
            return v[...].astype(np.float64) * float(v.attrs["scale_factor"][0]) + float(v.attrs["add_offset"][0])

        p = f["goes_imager_projection"].attrs
        meta = {
            "x": axis("x"),
            "y": axis("y"),
            "h": float(p["perspective_point_height"][0]),
            "r_eq": float(p["semi_major_axis"][0]),
            "r_pol": float(p["semi_minor_axis"][0]),
            "lon0": float(p["longitude_of_projection_origin"][0]),
            "time": f.attrs["time_coverage_start"].decode(),
            "platform": f.attrs["platform_ID"].decode(),
            "scene": f.attrs["scene_id"].decode(),
            "title": f.attrs["title"].decode(),
            "dataset": f.attrs["dataset_name"].decode() if "dataset_name" in f.attrs else path.name,
        }
    return data, meta


def latlon_to_scan(lat: np.ndarray, lon: np.ndarray, m: dict) -> tuple[np.ndarray, np.ndarray]:
    """Latitudine/longitudine geodetiche (gradi) → angoli di scansione ABI x, y (radianti)."""
    r_eq, r_pol = m["r_eq"], m["r_pol"]
    H = m["h"] + r_eq
    e2 = 1 - (r_pol * r_pol) / (r_eq * r_eq)
    phi = np.radians(lat)
    lam = np.radians(lon - m["lon0"])
    phi_c = np.arctan((r_pol * r_pol) / (r_eq * r_eq) * np.tan(phi))
    r_c = r_pol / np.sqrt(1 - e2 * np.cos(phi_c) ** 2)
    sx = H - r_c * np.cos(phi_c) * np.cos(lam)
    sy = -r_c * np.cos(phi_c) * np.sin(lam)
    sz = r_c * np.sin(phi_c)
    visible = H * (H - sx) >= sy * sy + (r_eq * r_eq) / (r_pol * r_pol) * sz * sz
    x = np.arcsin(-sy / np.sqrt(sx * sx + sy * sy + sz * sz))
    y = np.arctan(sz / sx)
    x[~visible] = np.nan
    y[~visible] = np.nan
    return x, y


def bilinear(img: np.ndarray, col: np.ndarray, row: np.ndarray) -> np.ndarray:
    """Campionamento bilineare con NaN fuori dall'immagine o vicino a valori mancanti."""
    h, w = img.shape
    out = np.full(col.shape, np.nan, dtype=np.float32)
    ok = np.isfinite(col) & np.isfinite(row) & (col >= 0) & (row >= 0) & (col <= w - 1) & (row <= h - 1)
    c, r = col[ok], row[ok]
    c0 = np.minimum(np.floor(c).astype(np.int64), w - 2)
    r0 = np.minimum(np.floor(r).astype(np.int64), h - 2)
    fc, fr = (c - c0).astype(np.float32), (r - r0).astype(np.float32)
    v = (
        img[r0, c0] * (1 - fc) * (1 - fr)
        + img[r0, c0 + 1] * fc * (1 - fr)
        + img[r0 + 1, c0] * (1 - fc) * fr
        + img[r0 + 1, c0 + 1] * fc * fr
    )
    out[ok] = v
    return out


def block_mean(img: np.ndarray, k: int) -> np.ndarray:
    h, w = (img.shape[0] // k) * k, (img.shape[1] // k) * k
    return np.nanmean(img[:h, :w].reshape(h // k, k, w // k, k), axis=(1, 3))


def sample(img: np.ndarray, m: dict, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    x, y = latlon_to_scan(lat, lon, m)
    xs, ys = m["x"], m["y"]
    col = (x - xs[0]) / (xs[1] - xs[0])
    row = (y - ys[0]) / (ys[1] - ys[0])
    return bilinear(img, col, row)


def cos_solar_zenith(lat: np.ndarray, lon: np.ndarray, when: datetime) -> np.ndarray:
    """Stesse formule a bassa precisione di src/core/astro.ts."""
    d = (when - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400
    g = math.radians((357.529 + 0.98560028 * d) % 360)
    q = (280.459 + 0.98564736 * d) % 360
    L = math.radians(q + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g))
    e = math.radians(23.439 - 0.00000036 * d)
    ra = math.atan2(math.cos(e) * math.sin(L), math.cos(L))
    dec = math.asin(math.sin(e) * math.sin(L))
    gmst = (280.46061837 + 360.98564736629 * d) % 360
    sub_lon = math.radians(((math.degrees(ra) - gmst + 180) % 360) - 180)
    phi = np.radians(lat)
    return np.sin(phi) * math.sin(dec) + np.cos(phi) * math.cos(dec) * np.cos(np.radians(lon) - sub_lon)


def to_u8(v: np.ndarray, lo: float, hi: float, fill: float) -> np.ndarray:
    v = np.where(np.isfinite(v), v, fill)
    return np.clip(np.rint((v - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--c02", type=Path, required=True)
    ap.add_argument("--c13", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bounds", type=float, nargs=4, default=[-100.0, 16.0, -68.0, 36.0], metavar=("W", "S", "E", "N"))
    ap.add_argument("--res", type=float, default=0.0125, help="passo della griglia in gradi")
    args = ap.parse_args()

    west, south, east, north = args.bounds
    width = round((east - west) / args.res)
    height = round((north - south) / args.res)
    # Centri delle celle; riga 0 = nord (orientamento delle immagini).
    lon = west + (np.arange(width) + 0.5) * args.res
    lat = north - (np.arange(height) + 0.5) * args.res
    lon2, lat2 = np.meshgrid(lon, lat)

    c13, m13 = read_cmi(args.c13)
    c02, m02 = read_cmi(args.c02)

    # C02 è a 0,5 km: media 2×2 (≈1 km) per evitare aliasing sulla griglia di destinazione.
    k = 2
    c02_1km = block_mean(c02, k)
    m02_1km = dict(m02)
    m02_1km["x"] = m02["x"][: c02_1km.shape[1] * k].reshape(-1, k).mean(axis=1)
    m02_1km["y"] = m02["y"][: c02_1km.shape[0] * k].reshape(-1, k).mean(axis=1)

    bt = sample(c13, m13, lat2, lon2)
    refl = sample(c02_1km, m02_1km, lat2, lon2)

    when = datetime.fromisoformat(m13["time"].replace("Z", "+00:00"))
    mu0 = cos_solar_zenith(lat2, lon2, when)
    # Riflettanza → albedo apparente; il browser riapplica l'illuminazione col Sole storico.
    albedo = refl / np.maximum(mu0, 0.15)

    valid = np.isfinite(bt) & np.isfinite(refl)
    args.out.mkdir(parents=True, exist_ok=True)
    albedo_u8 = to_u8(np.where(valid, albedo, np.nan), 0.0, ALBEDO_MAX, 0.0)
    bt_u8 = to_u8(np.where(valid, bt, np.nan), BT_MIN, BT_MAX, BT_MAX)
    Image.fromarray(albedo_u8, "L").save(args.out / "clouds-albedo.jpg", quality=88, optimize=True)
    Image.fromarray(bt_u8, "L").save(args.out / "clouds-bt.jpg", quality=90, optimize=True)

    meta = {
        "observed": m13["time"],
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "size": [width, height],
        "resolutionDeg": args.res,
        "encoding": {
            "clouds-albedo.jpg": {"quantity": "albedo apparente (riflettanza C02 / cos zenit solare)", "min": 0, "max": ALBEDO_MAX},
            "clouds-bt.jpg": {"quantity": "temperatura di brillanza C13", "unit": "K", "min": BT_MIN, "max": BT_MAX},
        },
        "validFraction": round(float(valid.mean()), 4),
        "source": {
            "satellite": m13["platform"],
            "sector": m13["scene"],
            "product": m13["title"],
            "files": [
                {"dataset": m02["dataset"], "sha256": sha256(args.c02), "start": m02["time"]},
                {"dataset": m13["dataset"], "sha256": sha256(args.c13), "start": m13["time"]},
            ],
            "archive": "NOAA Open Data Dissemination (NODD) — s3://noaa-goes16",
        },
    }
    (args.out / "clouds-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"griglia {width}×{height}, copertura valida {meta['validFraction']:.1%}")
    print(f"BT  min {np.nanmin(bt):.1f} K  max {np.nanmax(bt):.1f} K")
    print(f"albedo p50 {np.nanpercentile(albedo, 50):.3f}  p99 {np.nanpercentile(albedo, 99):.3f}")
    print(f"cos zenit solare min {np.nanmin(mu0):.2f} max {np.nanmax(mu0):.2f}")


if __name__ == "__main__":
    main()
