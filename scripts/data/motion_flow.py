"""
Campo di moto delle nuvole tra due osservazioni GOES successive (flusso ottico DIS, OpenCV).

Il moto viene stimato sul canale visibile dove il Sole è alto in entrambe le osservazioni
(più dettaglio) e sull'infrarosso altrove (uniforme di giorno e di notte): vicino al
terminatore il visibile cambia per la luce, non per le nubi, e darebbe moti fittizi.
I due campi sono fusi con un peso graduale sul coseno dello zenit solare (0,15–0,35).

Il campo serve SOLO a generare fotogrammi intermedi ILLUSTRATIVI tra osservazioni reali:
ogni pixel viene spostato lungo il moto stimato, invece di dissolvere un'immagine nell'altra.

Interpolazione (identica a quella prevista nello shader):
  I(p, t) = (1 − t) · A(p − t·v(p)) + t · B(p + (1 − t)·v(p))
dove v è lo spostamento A→B, in pixel della griglia albedo, stimato a metà intervallo
(media del flusso in avanti e dell'opposto di quello all'indietro).

Codifica su file: PNG 8 bit, 1/4 della risoluzione albedo, R = vx, G = vy,
valore = 128 + v · FLOW_SCALE (precisione 0,25 px, intervallo ±32 px).

Uso:
  scripts/data/.venv/bin/python -I scripts/data/motion_flow.py --frames data-raw/fase-a/frames
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from goes_clouds import cos_solar_zenith  # noqa: E402

FLOW_SCALE = 4.0
FLOW_DOWNSAMPLE = 4
FLOW_SMOOTH_PX = 3.0


def estimate_flow(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Spostamento A→B a metà intervallo, in pixel; array (h, w, 2) float32."""
    dis = cv2.DISOpticalFlow.create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(1)
    fwd = dis.calc(a, b, None)
    bwd = dis.calc(b, a, None)
    v = 0.5 * (fwd - bwd)
    return cv2.GaussianBlur(v, (0, 0), FLOW_SMOOTH_PX)


def ir_feature(bt_u8: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Infrarosso come immagine per il flusso: nubi fredde chiare, contrasto locale equalizzato."""
    up = cv2.resize(bt_u8, size, interpolation=cv2.INTER_CUBIC)
    return cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(255 - up)


def sun_weight(index: dict, a: dict, b: dict) -> np.ndarray:
    """1 dove il Sole è alto in entrambe le osservazioni, 0 vicino al terminatore e di notte."""
    bnd = index["bounds"]
    w, h = index["albedoSize"]
    res = (bnd["east"] - bnd["west"]) / w
    lon, lat = np.meshgrid(bnd["west"] + (np.arange(w) + 0.5) * res, bnd["north"] - (np.arange(h) + 0.5) * res)
    mu = np.minimum(*(cos_solar_zenith(lat, lon, datetime.fromisoformat(f["observed"].replace("Z", "+00:00"))) for f in (a, b)))
    t = np.clip((mu - 0.15) / 0.2, 0, 1)
    return (t * t * (3 - 2 * t)).astype(np.float32)


def encode_flow(v: np.ndarray) -> tuple[np.ndarray, float]:
    """Riduce e quantizza il campo; restituisce RGB 8 bit e il massimo |v| prima del taglio."""
    h, w = v.shape[:2]
    small = cv2.resize(v, (w // FLOW_DOWNSAMPLE, h // FLOW_DOWNSAMPLE), interpolation=cv2.INTER_AREA)
    q = np.clip(np.rint(128 + small * FLOW_SCALE), 0, 255).astype(np.uint8)
    rgb = np.dstack([q[..., 0], q[..., 1], np.full(q.shape[:2], 128, np.uint8)])
    return rgb, float(np.abs(v).max())


def decode_flow(rgb: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Inverso di encode_flow, riportato a risoluzione piena con filtro bilineare (come la GPU)."""
    v = (rgb[..., :2].astype(np.float32) - 128) / FLOW_SCALE
    return cv2.resize(v, size, interpolation=cv2.INTER_LINEAR)


def warp(img: np.ndarray, v: np.ndarray, k: float) -> np.ndarray:
    """img campionata in p + k·v(p) (bilineare, bordi replicati)."""
    h, w = img.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + k * v[..., 0], gy + k * v[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def interpolate(a: np.ndarray, b: np.ndarray, v: np.ndarray, t: float) -> np.ndarray:
    """Fotogramma intermedio ILLUSTRATIVO al tempo frazionario t ∈ [0, 1]."""
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    return (1 - t) * warp(a, v, -t) + t * warp(b, v, 1 - t)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=Path, required=True, help="cartella con frames.json")
    args = ap.parse_args()

    index_path = args.frames / "frames.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    frames = index["frames"]
    for fa, fb in zip(frames, frames[1:]):
        size = tuple(index["albedoSize"])
        w = sun_weight(index, fa, fb)
        ir = [ir_feature(np.asarray(Image.open(args.frames / f["bt"]).convert("L")), size) for f in (fa, fb)]
        v = estimate_flow(*ir)
        if w.max() > 0:
            vis = [np.asarray(Image.open(args.frames / f["albedo"]).convert("L")) for f in (fa, fb)]
            v = w[..., None] * estimate_flow(*vis) + (1 - w[..., None]) * v
        rgb, vmax = encode_flow(v)
        name = f"{fa['id']}-flow.png"
        Image.fromarray(rgb, "RGB").save(args.frames / name, optimize=True)
        fa["flow"] = name
        fa["flowMaxPx"] = round(vmax, 2)
        print(f"{fa['id']} → {fb['id']}: |v| max {vmax:.1f} px, medio {np.hypot(v[..., 0], v[..., 1]).mean():.2f} px")
    index["flowEncoding"] = {
        "file": "PNG RGB 8 bit, R = vx, G = vy (pixel albedo verso est e verso sud)",
        "downsample": FLOW_DOWNSAMPLE,
        "scale": FLOW_SCALE,
        "offset": 128,
        "method": f"OpenCV DIS (preset medium) su visibile e infrarosso fusi col Sole, media avanti/indietro, sfocatura gaussiana σ = {FLOW_SMOOTH_PX} px",
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
