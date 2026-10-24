"""
Sequenza di osservazioni GOES-16 ABI (L2 MCMIP, settore CONUS) per l'animazione delle nuvole.

Per ogni istante produce, sulla regione dell'evento (equirettangolare, riga 0 = nord):

  <id>-albedo.jpg  canale 2 (0,64 µm), albedo apparente, griglia --res (1280×800 di default)
  <id>-bt.jpg      canale 13 (10,3 µm), temperatura di brillanza, griglia 2 × --res (640×400)

e un indice frames.json con orari effettivi di scansione, file sorgente e byte scaricati.

Download minimo: il prodotto multicanale MCMIP contiene già il canale 2 a 2 km (media NOAA
dei pixel da 0,5 km), sufficiente per la griglia da ~2,6 km. I file NetCDF4 sono divisi in
blocchi compressi di 250×250 pixel: con richieste HTTP parziali (Range) si leggono solo i
blocchi della regione (~10 MB per istante invece di ~60 MB). Accesso anonimo all'archivio
pubblico NOAA (NODD, s3://noaa-goes16): nessun account, nessuna chiave, nessun costo.

Correzione della parallasse (--parallax): ABI georeferenzia ogni pixel come se ciò che vede
stesse sulla superficie dell'ellissoide. Una nube a quota h appare quindi spostata in
direzione opposta al satellite di circa h · tan(angolo zenitale del satellite): per
l'occhio di Milton (~16 km, zenit ~37°) sono ~10 km, cioè 4 pixel. La correzione calcola,
per ogni punto della griglia alla quota stimata della sommità, la direzione di vista esatta
del satellite (stessa geometria della GOES-R PUG, con l'altitudine) e campiona lì.
La quota viene stimata dalla temperatura di brillanza, (300 K − BT) / 6,5 K/km, limitata a
0–16 km: è la stessa stima usata per il rilievo nel browser ed è approssimata (± 2–3 km,
quindi ± ~2 km di spostamento residuo). Le nubi basse (< 3 km) si spostano meno di 1 pixel.

Uso:
  scripts/data/.venv/bin/python -I scripts/data/goes_sequence.py \
      --start 2024-10-07T12:20 --count 35 --step 20 --parallax --out data-raw/fase-a2/frames
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import h5py
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from goes_clouds import ALBEDO_MAX, BT_MAX, BT_MIN, bilinear, cos_solar_zenith, to_u8  # noqa: E402

BUCKET = "https://noaa-goes16.s3.amazonaws.com"
PRODUCT = "ABI-L2-MCMIPC"
USER_AGENT = "ATMOSPHERA-data-pipeline (uso locale, una tantum)"
LAPSE_K_PER_KM = 6.5
MAX_TOP_KM = 16.0


class RangeFile:
    """File remoto in sola lettura, letto a blocchi con richieste HTTP Range (per h5py)."""

    BLOCK = 1 << 18  # 256 KB

    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        self.blocks: dict[int, bytes] = {}
        self.downloaded = 0
        self.requests = 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
            self.etag = r.headers.get("ETag", "").strip('"')

    def _block(self, i: int) -> bytes:
        if i not in self.blocks:
            start = i * self.BLOCK
            end = min(start + self.BLOCK, self.size) - 1
            req = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}", "User-Agent": USER_AGENT})
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(req, timeout=120) as r:
                        data = r.read()
                    break
                except OSError:
                    if attempt == 3:
                        raise
            self.blocks[i] = data
            self.downloaded += len(data)
            self.requests += 1
        return self.blocks[i]

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            i, off = divmod(self.pos, self.BLOCK)
            chunk = self._block(i)[off : off + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, buf) -> int:
        data = self.read(len(buf))
        buf[: len(data)] = data
        return len(data)

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def tell(self) -> int:
        return self.pos

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True


def list_scans(hour: datetime) -> list[tuple[datetime, str, int]]:
    """Scansioni disponibili in un'ora: (inizio scansione, chiave, dimensione)."""
    prefix = f"{PRODUCT}/{hour:%Y}/{hour.timetuple().tm_yday:03d}/{hour:%H}/OR_{PRODUCT}-M6_G16_"
    url = f"{BUCKET}/?list-type=2&prefix={prefix}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=60) as r:
        root = ET.fromstring(r.read())
    ns = {"s3": root.tag.split("}")[0].strip("{")}
    scans = []
    for c in root.findall("s3:Contents", ns):
        key = c.findtext("s3:Key", namespaces=ns) or ""
        m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_", key)
        if not m:
            continue
        y, doy, hh, mm, ss, tenth = (int(g) for g in m.groups())
        start = datetime(y, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1, hours=hh, minutes=mm, seconds=ss + tenth / 10)
        scans.append((start, key, int(c.findtext("s3:Size", namespaces=ns) or 0)))
    return sorted(scans)


def pick_scan(nominal: datetime) -> tuple[datetime, str, int]:
    """Prima scansione che inizia entro 5 minuti dopo l'istante nominale."""
    for start, key, size in list_scans(nominal):
        if nominal <= start < nominal + timedelta(minutes=5):
            return start, key, size
    raise SystemExit(f"nessuna scansione per {nominal:%Y-%m-%d %H:%M} UTC")


def projection(f: h5py.File) -> dict:
    p = f["goes_imager_projection"].attrs
    return {
        "h": float(p["perspective_point_height"][0]),
        "r_eq": float(p["semi_major_axis"][0]),
        "r_pol": float(p["semi_minor_axis"][0]),
        "lon0": float(p["longitude_of_projection_origin"][0]),
    }


def scan_angles(lat: np.ndarray, lon: np.ndarray, alt_m: np.ndarray | float, m: dict) -> tuple[np.ndarray, np.ndarray]:
    """Angoli di scansione ABI (x, y, radianti) di un punto geodetico a quota alt_m sull'ellissoide.

    Con alt_m = 0 coincide con le formule della GOES-R PUG (vol. 5, sez. 4.2.8)."""
    r_eq, r_pol = m["r_eq"], m["r_pol"]
    e2 = 1 - (r_pol * r_pol) / (r_eq * r_eq)
    H = m["h"] + r_eq
    phi = np.radians(lat)
    lam = np.radians(lon - m["lon0"])
    n = r_eq / np.sqrt(1 - e2 * np.sin(phi) ** 2)
    px = (n + alt_m) * np.cos(phi) * np.cos(lam)
    py = (n + alt_m) * np.cos(phi) * np.sin(lam)
    pz = (n * (1 - e2) + alt_m) * np.sin(phi)
    sx, sy, sz = H - px, -py, pz
    x = np.arcsin(-sy / np.sqrt(sx * sx + sy * sy + sz * sz))
    y = np.arctan(sz / sx)
    return x, y


def read_window(f: h5py.File, var: str, m: dict, lat: np.ndarray, lon: np.ndarray, margin: int):
    """Legge solo la finestra della variabile che copre la griglia (con margine per la parallasse)."""

    def axis(name: str) -> np.ndarray:
        v = f[name]
        return v[...].astype(np.float64) * float(v.attrs["scale_factor"][0]) + float(v.attrs["add_offset"][0])

    xs, ys = axis("x"), axis("y")
    edge_lat = np.concatenate([lat[0, :], lat[-1, :], lat[:, 0], lat[:, -1]])
    edge_lon = np.concatenate([lon[0, :], lon[-1, :], lon[:, 0], lon[:, -1]])
    cols, rows = [], []
    for alt in (0.0, MAX_TOP_KM * 1000):
        x, y = scan_angles(edge_lat, edge_lon, alt, m)
        cols.append((x - xs[0]) / (xs[1] - xs[0]))
        rows.append((y - ys[0]) / (ys[1] - ys[0]))
    cols, rows = np.concatenate(cols), np.concatenate(rows)
    c0 = max(int(np.floor(np.nanmin(cols))) - margin, 0)
    c1 = min(int(np.ceil(np.nanmax(cols))) + margin + 1, xs.size)
    r0 = max(int(np.floor(np.nanmin(rows))) - margin, 0)
    r1 = min(int(np.ceil(np.nanmax(rows))) + margin + 1, ys.size)
    v = f[var]
    raw = v[r0:r1, c0:c1]
    data = raw.astype(np.float32) * float(v.attrs["scale_factor"][0]) + float(v.attrs["add_offset"][0])
    data[raw == int(v.attrs["_FillValue"][0])] = np.nan
    return data, xs[c0:c1], ys[r0:r1], [int(r0), int(r1), int(c0), int(c1)]


def sample(img, xs, ys, m, lat, lon, alt_m):
    x, y = scan_angles(lat, lon, alt_m, m)
    return bilinear(img, (x - xs[0]) / (xs[1] - xs[0]), (y - ys[0]) / (ys[1] - ys[0]))


def top_height_m(bt: np.ndarray) -> np.ndarray:
    """Quota stimata della sommità dalla temperatura di brillanza (stessa stima del browser)."""
    return np.clip((300.0 - np.nan_to_num(bt, nan=300.0)) / LAPSE_K_PER_KM, 0.0, MAX_TOP_KM) * 1000.0


def smooth(a: np.ndarray, passes: int = 2) -> np.ndarray:
    """Media mobile 3×3 ripetuta: evita salti netti della correzione ai bordi delle nubi."""
    for _ in range(passes):
        p = np.pad(a, 1, mode="edge")
        a = sum(p[dy : dy + a.shape[0], dx : dx + a.shape[1]] for dy in range(3) for dx in range(3)) / 9.0
    return a


def process(task: dict) -> dict:
    """Un istante: lettura remota parziale, riproiezione (con parallasse), JPEG. Gira in un processo."""
    out = Path(task["out"])
    west, south, east, north = task["bounds"]
    res = task["res"]
    width, height = round((east - west) / res), round((north - south) / res)
    lon = west + (np.arange(width) + 0.5) * res
    lat = north - (np.arange(height) + 0.5) * res
    lon2, lat2 = np.meshgrid(lon, lat)

    nominal = datetime.fromisoformat(task["nominal"])
    _, key, size = pick_scan(nominal)
    rf = RangeFile(f"{BUCKET}/{key}")
    with h5py.File(rf, "r") as f:
        m = projection(f)
        c02, x02, y02, win = read_window(f, "CMI_C02", m, lat2, lon2, margin=4)
        c13, x13, y13, _ = read_window(f, "CMI_C13", m, lat2, lon2, margin=4)
        observed_s = f.attrs["time_coverage_start"].decode()

    alt = np.zeros_like(lat2)
    if task["parallax"]:
        # Iterazione a punto fisso: la quota dipende dalla BT letta nel punto corretto.
        for _ in range(3):
            bt = sample(c13, x13, y13, m, lat2, lon2, alt)
            alt = smooth(top_height_m(bt))
    bt = sample(c13, x13, y13, m, lat2, lon2, alt)
    refl = sample(c02, x02, y02, m, lat2, lon2, alt)
    observed = datetime.fromisoformat(observed_s.replace("Z", "+00:00"))
    mu0 = cos_solar_zenith(lat2, lon2, observed)
    # Albedo apparente; di notte (Sole sotto l'orizzonte) il canale visibile non porta informazione.
    albedo = np.where(mu0 > 0.0, refl / np.maximum(mu0, 0.15), 0.0)
    valid = np.isfinite(bt) & np.isfinite(refl)
    bt_half = np.nanmean(np.where(valid, bt, np.nan).reshape(height // 2, 2, width // 2, 2), axis=(1, 3))

    fid = observed.strftime("%Y%m%dT%H%MZ")
    q = task["quality"]
    Image.fromarray(to_u8(np.where(valid, albedo, np.nan), 0.0, ALBEDO_MAX, 0.0), "L").save(out / f"{fid}-albedo.jpg", quality=q, optimize=True)
    Image.fromarray(to_u8(bt_half, BT_MIN, BT_MAX, BT_MAX), "L").save(out / f"{fid}-bt.jpg", quality=q, optimize=True)
    shift_km = None
    if task["parallax"]:
        x0, y0 = scan_angles(lat2, lon2, 0.0, m)
        x1, y1 = scan_angles(lat2, lon2, alt, m)
        # Spostamento apparente in km (angolo di scansione × distanza ~ satellite–Terra).
        d = np.hypot(x1 - x0, y1 - y0) * (m["h"] - 0) / 1000.0
        shift_km = round(float(np.percentile(d, 99.9)), 1)
    return {
        "id": fid,
        "nominal": nominal.strftime("%Y-%m-%dT%H:%MZ"),
        "observed": observed_s,
        "albedo": f"{fid}-albedo.jpg",
        "bt": f"{fid}-bt.jpg",
        "validFraction": round(float(valid.mean()), 4),
        "sunlitFraction": round(float((mu0 > 0.05).mean()), 4),
        "parallaxShiftKmP999": shift_km,
        "source": {"key": key, "size": size, "etag": rf.etag, "window": win, "downloadedBytes": rf.downloaded, "requests": rf.requests},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="istante nominale iniziale, UTC (es. 2024-10-07T12:20)")
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--step", type=int, default=10, help="minuti tra due osservazioni")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bounds", type=float, nargs=4, default=[-100.0, 16.0, -68.0, 36.0], metavar=("W", "S", "E", "N"))
    ap.add_argument("--res", type=float, default=0.025, help="passo della griglia albedo, in gradi")
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--parallax", action="store_true", help="corregge la parallasse delle sommità (vedi sopra)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
    tasks = [
        {
            "nominal": (start + timedelta(minutes=args.step * i)).isoformat(),
            "out": str(args.out),
            "bounds": args.bounds,
            "res": args.res,
            "quality": args.quality,
            "parallax": args.parallax,
        }
        for i in range(args.count)
    ]
    frames = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for fr in pool.map(process, tasks):
            frames.append(fr)
            print(f"{fr['id']}  scaricati {fr['source']['downloadedBytes'] / 1e6:.1f} MB  parallasse p99,9 {fr['parallaxShiftKmP999']} km", flush=True)

    west, south, east, north = args.bounds
    width, height = round((east - west) / args.res), round((north - south) / args.res)
    total = sum(f["source"]["downloadedBytes"] for f in frames)
    index = {
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "albedoSize": [width, height],
        "btSize": [width // 2, height // 2],
        "encoding": {
            "albedo": {"quantity": "albedo apparente (riflettanza C02 / cos zenit solare), 0 di notte", "min": 0, "max": ALBEDO_MAX},
            "bt": {"quantity": "temperatura di brillanza C13", "unit": "K", "min": BT_MIN, "max": BT_MAX},
        },
        "parallax": {
            "corrected": args.parallax,
            "model": "quota sommità = (300 K − BT) / 6,5 K/km, 0–16 km; geometria di vista GOES-R PUG con altitudine",
        },
        "product": PRODUCT,
        "archive": "NOAA Open Data Dissemination (NODD) — s3://noaa-goes16",
        "downloadedBytes": total,
        "frames": frames,
    }
    (args.out / "frames.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"scaricati in totale {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
