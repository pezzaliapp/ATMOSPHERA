"""
Verifica locale del moto delle nuvole (FASE A): video di anteprima e misure di qualità.

Strumento di sviluppo, non incluso nell'app. Produce in --out:

  regione.mp4     vista 2D della regione, osservazioni + fotogrammi interpolati
  occhio.mp4      ingrandimento sull'occhio, con la posizione NOAA (HURDAT2) per confronto
  confronto.mp4   occhio con tre metodi affiancati: solo osservazioni, dissolvenza, moto
  verifica.png    test a campione escluso: l'osservazione centrale ricostruita dalle due estreme
  misure.json     numeri della verifica

Le texture vengono campionate come farebbe la GPU nella scena 3D: ogni pixel dello schermo
legge le immagini a coordinate continue con filtro bilineare (qui con ingrandimento fisso).
L'anteprima usa lo stesso modello di opacità e quota delle nuvole del browser
(src/globe/shading.ts) con un'ombreggiatura semplificata; la scena 3D resta quella dell'app.

Uso:
  scripts/data/.venv/bin/python -I scripts/data/preview_motion.py \
      --frames data-raw/fase-a/frames --surface public/data/events/milton-2024/surface.jpg \
      --track public/data/events/milton-2024/track.json --out data-raw/fase-a
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from goes_clouds import BT_MAX, BT_MIN  # noqa: E402
from motion_flow import decode_flow, estimate_flow, interpolate  # noqa: E402

FPS = 30
SECONDS_PER_INTERVAL = 2.5  # 10 minuti di osservazioni in 2,5 s (1 ora ≈ 15 s)
LOOPS = 3
KM_PER_PX = 2.6  # griglia albedo da 0,025°


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class Region:
    def __init__(self, index: dict):
        b = index["bounds"]
        self.west, self.south, self.east, self.north = b["west"], b["south"], b["east"], b["north"]
        self.w, self.h = index["albedoSize"]
        self.res = (self.east - self.west) / self.w

    def to_px(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.west) / self.res - 0.5, (self.north - lat) / self.res - 0.5


class View:
    """Finestra della regione (in pixel albedo) resa a scala fissa con campionamento bilineare."""

    def __init__(self, x0: float, y0: float, w: int, h: int, scale: float):
        self.x0, self.y0, self.w, self.h, self.scale = x0, y0, w, h, scale
        self.size = (int(round(w * scale)), int(round(h * scale)))
        gx, gy = np.meshgrid(np.arange(self.size[0], dtype=np.float32), np.arange(self.size[1], dtype=np.float32))
        self.mx = x0 + (gx + 0.5) / scale - 0.5
        self.my = y0 + (gy + 0.5) / scale - 0.5

    @staticmethod
    def sample(img: np.ndarray, mx: np.ndarray, my: np.ndarray) -> np.ndarray:
        return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def at(self, img: np.ndarray, factor: float = 1.0, dx: np.ndarray | float = 0.0, dy: np.ndarray | float = 0.0):
        """img (griglia = griglia albedo × factor) letta nei punti della vista spostati di (dx, dy)."""
        mx = (self.mx + dx + 0.5) * factor - 0.5
        my = (self.my + dy + 0.5) * factor - 0.5
        return self.sample(img, mx.astype(np.float32), my.astype(np.float32))

    def to_view(self, x: float, y: float) -> tuple[int, int]:
        return int((x - self.x0 + 0.5) * self.scale), int((y - self.y0 + 0.5) * self.scale)


def render(albedo: np.ndarray, bt_k: np.ndarray, surface: np.ndarray, km_per_px: float) -> np.ndarray:
    """Composizione 2D: stessa opacità del browser, rilievo dalla quota ricostruita."""
    a = albedo / 255.0
    not_hot = smoothstep(304.0, 297.0, bt_k)
    opacity = np.power(np.clip((a - 0.09) / 0.55, 0, 1), 0.85) * not_hot
    solid = smoothstep(0.15, 0.7, opacity)
    height = np.clip((300.0 - bt_k) / 6.5, 0, 16) * 2.0 * solid  # km, esagerazione ×2 come nell'app
    height = cv2.GaussianBlur(height.astype(np.float32), (0, 0), 2.6 / km_per_px)
    gy, gx = np.gradient(height, km_per_px)
    # Sole delle 20 UTC sul Golfo: alto, da sud-ovest.
    light = np.array([-0.45, 0.45, 0.77])  # (est, nord, su)
    light /= np.linalg.norm(light)
    n = np.dstack([-gx * 0.6, gy * 0.6, np.ones_like(gx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    lambert = np.clip(n @ light, 0, 1)
    bright = 0.62 + 0.38 * smoothstep(0.2, 0.85, a)
    shade = bright * (0.42 + 0.68 * lambert)
    cloud = np.dstack([shade * 0.97, shade * 0.99, shade * 1.0])
    out = surface * (1 - opacity[..., None]) + cloud * opacity[..., None]
    return np.clip(out * 255, 0, 255).astype(np.uint8)


def find_eye(albedo: np.ndarray, guess: tuple[float, float], radius: int = 14) -> tuple[float, float]:
    """Centro dell'occhio: minimo di albedo vicino alla posizione attesa, raffinato al sub-pixel."""
    gx, gy = int(round(guess[0])), int(round(guess[1]))
    win = cv2.GaussianBlur(albedo.astype(np.float32), (0, 0), 1.0)[gy - radius : gy + radius + 1, gx - radius : gx + radius + 1]
    y0, x0 = np.unravel_index(np.argmin(win), win.shape)
    k = 3
    sub = win[max(y0 - k, 0) : y0 + k + 1, max(x0 - k, 0) : x0 + k + 1]
    w = np.clip(np.percentile(sub, 60) - sub, 0, None)
    ys, xs = np.mgrid[0 : sub.shape[0], 0 : sub.shape[1]]
    cx = (xs * w).sum() / w.sum() + max(x0 - k, 0)
    cy = (ys * w).sum() / w.sum() + max(y0 - k, 0)
    return gx - radius + cx, gy - radius + cy


def track_position(track: list[dict], when: datetime) -> tuple[float, float]:
    pts = [(parse_time(p["time"]), p["lat"], p["lon"]) for p in track]
    for (t0, la0, lo0), (t1, la1, lo1) in zip(pts, pts[1:]):
        if t0 <= when <= t1:
            f = (when - t0) / (t1 - t0)
            return la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f
    raise ValueError(when)


def label(img: np.ndarray, lines: list[tuple[str, tuple[int, int, int]]], scale: float = 0.7) -> None:
    y = 32
    for text, color in lines:
        cv2.putText(img, text, (16, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(img, text, (16, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)
        y += int(30 * scale / 0.7)


class Video:
    def __init__(self, path: Path, size: tuple[int, int]):
        self.path = path
        self.tmp = path.with_suffix(".mp4v.mp4")
        self.writer = cv2.VideoWriter(str(self.tmp), cv2.VideoWriter_fourcc(*"mp4v"), FPS, size)
        self.frames: list[np.ndarray] = []

    def add(self, rgb: np.ndarray) -> None:
        # Compresso in memoria: il video viene scritto alla fine, ripetuto LOOPS volte.
        self.frames.append(cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 96])[1])

    def close(self) -> None:
        for _ in range(LOOPS):
            for f in self.frames:
                self.writer.write(cv2.imdecode(f, cv2.IMREAD_COLOR))
        self.writer.release()
        # Ricodifica H.264 con lo strumento di sistema di macOS (riproducibile in Safari e QuickTime).
        r = subprocess.run(
            ["avconvert", "-s", str(self.tmp), "-o", str(self.path), "-p", "PresetHighestQuality", "--replace"],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and self.path.exists():
            self.tmp.unlink()
        else:
            self.tmp.replace(self.path)
            print(f"avconvert non riuscito, lasciato MPEG-4 Part 2: {r.stderr.strip()}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--surface", type=Path, required=True)
    ap.add_argument("--track", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    index = json.loads((args.frames / "frames.json").read_text(encoding="utf-8"))
    region = Region(index)
    size = (region.w, region.h)
    frames = index["frames"]
    track = json.loads(args.track.read_text(encoding="utf-8"))
    track = track.get("points", track)
    times = [parse_time(f["observed"]) for f in frames]

    surface_img = np.asarray(Image.open(args.surface).convert("RGB")).astype(np.float32) / 255
    surface_factor = surface_img.shape[1] / region.w
    albedo = [np.asarray(Image.open(args.frames / f["albedo"]).convert("L")).astype(np.float32) for f in frames]
    bt = [np.asarray(Image.open(args.frames / f["bt"]).convert("L")).astype(np.float32) for f in frames]
    bt_factor = bt[0].shape[1] / region.w
    flows = [decode_flow(np.asarray(Image.open(args.frames / f["flow"])), size) for f in frames[:-1]]

    def bt_kelvin(v: np.ndarray) -> np.ndarray:
        return BT_MIN + v / 255.0 * (BT_MAX - BT_MIN)

    def fields(view: View, method: str, i: int, t: float) -> tuple[np.ndarray, np.ndarray]:
        """Albedo e BT nei punti della vista, al tempo frazionario t tra le osservazioni i e i+1."""
        if t in (0.0, 1.0) or method == "step":
            j = i if t < 0.5 else i + 1
            return view.at(albedo[j]), view.at(bt[j], bt_factor)
        if method == "fade":
            return (
                (1 - t) * view.at(albedo[i]) + t * view.at(albedo[i + 1]),
                (1 - t) * view.at(bt[i], bt_factor) + t * view.at(bt[i + 1], bt_factor),
            )
        # Moto: stessa formula dello shader previsto (vedi motion_flow.py).
        vx, vy = view.at(flows[i][..., 0]), view.at(flows[i][..., 1])
        a = (1 - t) * view.at(albedo[i], 1, -t * vx, -t * vy) + t * view.at(albedo[i + 1], 1, (1 - t) * vx, (1 - t) * vy)
        b = (1 - t) * view.at(bt[i], bt_factor, -t * vx, -t * vy) + t * view.at(bt[i + 1], bt_factor, (1 - t) * vx, (1 - t) * vy)
        return a, b

    def draw(view: View, method: str, i: int, t: float) -> np.ndarray:
        a, b = fields(view, method, i, t)
        return render(a, bt_kelvin(b), view.at(surface_img, surface_factor), KM_PER_PX / view.scale)

    # ---- Viste --------------------------------------------------------------------------------
    ex, ey = region.to_px(*track_position(track, times[len(times) // 2]))
    full = View(0, 0, region.w, region.h, 1.5)  # 1920×1200
    eye_view = View(ex - 80, ey - 50, 160, 100, 6)  # ≈ 420 × 260 km, 960×600
    cmp_view = View(ex - 80, ey - 50, 160, 100, 4)  # tre pannelli 640×400
    data_view = View(0, 0, region.w, region.h, 1)  # griglia dei dati, per la ricerca dell'occhio

    steps = int(round(SECONDS_PER_INTERVAL * FPS))
    seq = [(i, s / steps, times[i] + (times[i + 1] - times[i]) * (s / steps)) for i in range(len(frames) - 1) for s in range(steps)]
    seq.append((len(frames) - 2, 1.0, times[-1]))

    args.out.mkdir(parents=True, exist_ok=True)
    v_region = Video(args.out / "regione.mp4", full.size)
    v_eye = Video(args.out / "occhio.mp4", eye_view.size)
    v_cmp = Video(args.out / "confronto.mp4", (cmp_view.size[0] * 3, cmp_view.size[1] + 44))

    tag_obs = ("OSSERVATO - GOES-16", (120, 230, 255))
    tag_int = ("INTERPOLATO - illustrativo", (255, 200, 90))
    methods = (("step", "Solo osservazioni"), ("fade", "Dissolvenza"), ("flow", "Interpolazione del moto"))

    def stamp(when: datetime) -> str:
        return when.strftime("7 ott 2024  %H:%M:%S UTC")

    def lap(img: np.ndarray) -> float:
        return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32), cv2.CV_32F).var())

    eye_track = []
    diffs: dict[str, list[float]] = {m: [] for m, _ in methods}
    sharpness: dict[str, list[float]] = {m: [] for m, _ in methods}
    prev: dict[str, np.ndarray] = {}
    for i, t, when in seq:
        observed = t in (0.0, 1.0)
        tag = tag_obs if observed else tag_int

        img = draw(full, "flow", i, t)
        label(img, [(stamp(when), (255, 255, 255)), tag], 0.9)
        v_region.add(img)

        eye = draw(eye_view, "flow", i, t)
        px, py = eye_view.to_view(*region.to_px(*track_position(track, when)))
        # Posizione NOAA: mirino aperto attorno al punto, senza coprire l'occhio.
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cv2.line(eye, (px + dx * 24, py + dy * 24), (px + dx * 40, py + dy * 40), (255, 80, 80), 2, cv2.LINE_AA)
        label(eye, [(stamp(when), (255, 255, 255)), tag, ("mirino rosso: posizione NOAA HURDAT2", (255, 130, 130))])
        v_eye.add(eye)

        cw, chh = cmp_view.size
        row = np.zeros((chh + 44, cw * 3, 3), np.uint8)
        for k, (method, title) in enumerate(methods):
            panel = draw(cmp_view, method, i, t)
            row[44:, k * cw : (k + 1) * cw] = panel
            cv2.putText(row, title, (k * cw + 14, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 1, cv2.LINE_AA)
            g = panel.astype(np.float32)
            if method in prev:
                diffs[method].append(float(np.abs(g - prev[method]).mean()))
            prev[method] = g
            sharpness[method].append(lap(panel))
        cv2.putText(row, stamp(when), (cw * 3 - 330, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (200, 200, 200), 1, cv2.LINE_AA)
        v_cmp.add(row)

        # Occhio cercato sull'albedo interpolata alla risoluzione dei dati (1:1).
        a_full, _ = fields(data_view, "flow", i, t) if not observed else (albedo[i if t == 0.0 else i + 1], None)
        guess = region.to_px(*track_position(track, when))
        e = find_eye(a_full, guess)
        eye_track.append({"time": when.isoformat(), "observed": observed, "x": e[0], "y": e[1], "noaa": guess})
    for v in (v_region, v_eye, v_cmp):
        v.close()

    # ---- Test a campione escluso: osservazione centrale ricostruita dalle estreme ------------
    t_mid = (times[1] - times[0]) / (times[2] - times[0])
    v02 = estimate_flow(albedo[0].astype(np.uint8), albedo[2].astype(np.uint8))
    hv = View(ex - 120, ey - 75, 240, 150, 4)  # zona della tempesta, campionata come la GPU
    vx, vy = hv.at(v02[..., 0]), hv.at(v02[..., 1])
    obs = hv.at(albedo[1])
    pred = {
        "solo osservazione precedente": hv.at(albedo[0]),
        "dissolvenza": (1 - t_mid) * hv.at(albedo[0]) + t_mid * hv.at(albedo[2]),
        "interpolazione del moto": (1 - t_mid) * hv.at(albedo[0], 1, -t_mid * vx, -t_mid * vy)
        + t_mid * hv.at(albedo[2], 1, (1 - t_mid) * vx, (1 - t_mid) * vy),
    }
    ecx, ecy = hv.to_view(ex, ey)
    eye_box = (slice(ecy - 48, ecy + 48), slice(ecx - 48, ecx + 48))

    def lapg(x: np.ndarray) -> float:
        return float(cv2.Laplacian(x.astype(np.float32), cv2.CV_32F).var())

    holdout: dict[str, object] = {}
    for name, p in pred.items():
        holdout[name] = {
            "erroreMedioTempesta": round(float(np.abs(p - obs).mean()), 2),
            "erroreMedioOcchio": round(float(np.abs(p[eye_box] - obs[eye_box]).mean()), 2),
            "nitidezzaRelativa": round(lapg(p) / lapg(obs), 3),
        }
    pred_full = interpolate(albedo[0], albedo[2], v02, t_mid)
    g1 = region.to_px(*track_position(track, times[1]))
    oe, pe = find_eye(albedo[1], g1), find_eye(pred_full, g1)
    holdout["occhioRicostruitoVsOsservatoKm"] = round(float(np.hypot(pe[0] - oe[0], pe[1] - oe[1])) * KM_PER_PX, 2)

    tiles = [
        (f"Osservato {times[1]:%H:%M} UTC", obs),
        (f"Dissolvenza {times[0]:%H:%M} + {times[2]:%H:%M}", pred["dissolvenza"]),
        (f"Moto da {times[0]:%H:%M} e {times[2]:%H:%M}", pred["interpolazione del moto"]),
    ]
    tw, th = hv.size
    panel = np.zeros((th + 44, tw * 3), np.uint8)
    for k, (title, img) in enumerate(tiles):
        panel[44:, k * tw : (k + 1) * tw] = np.clip(img, 0, 255).astype(np.uint8)
        cv2.putText(panel, title, (k * tw + 14, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.75, 255, 1, cv2.LINE_AA)
    Image.fromarray(panel).save(args.out / "verifica.png")

    # ---- Stabilità dell'occhio e regolarità del movimento -----------------------------------
    xs = np.array([e["x"] for e in eye_track])
    ys = np.array([e["y"] for e in eye_track])
    step_px = np.hypot(np.diff(xs), np.diff(ys))
    accel = np.hypot(np.diff(xs, 2), np.diff(ys, 2))
    obs_err = [round(float(np.hypot(e["x"] - e["noaa"][0], e["y"] - e["noaa"][1])) * KM_PER_PX, 1) for e in eye_track if e["observed"]]

    def stats(d: list[float]) -> dict:
        arr = np.array(d)
        return {"medio": round(float(arr.mean()), 3), "massimo": round(float(arr.max()), 3), "rapportoMaxMedio": round(float(arr.max() / arr.mean()), 2)}

    def breathing(d: list[float]) -> dict:
        arr = np.array(d) / d[0]
        return {"minimoRelativo": round(float(arr.min()), 3), "medioRelativo": round(float(arr.mean()), 3)}

    measures = {
        "fotogrammiPerIntervallo": steps,
        "secondiPerIntervallo": SECONDS_PER_INTERVAL,
        "flussoMaxPx": [f.get("flowMaxPx") for f in frames[:-1]],
        "occhio": {
            "distanzaDaNoaaKmNelleOsservazioni": obs_err,
            "spostamentoPerFotogrammaKm": {
                "medio": round(float(step_px.mean()) * KM_PER_PX, 3),
                "massimo": round(float(step_px.max()) * KM_PER_PX, 3),
            },
            "accelerazioneMaxKm": round(float(accel.max()) * KM_PER_PX, 3),
            "derivaTotaleKm": round(float(np.hypot(xs[-1] - xs[0], ys[-1] - ys[0])) * KM_PER_PX, 1),
        },
        "variazioneTraFotogrammiZonaOcchio": {k: stats(v) for k, v in diffs.items()},
        "nitidezzaNelTempoZonaOcchio": {k: breathing(v) for k, v in sharpness.items()},
        "testCampioneEscluso": holdout,
    }
    (args.out / "misure.json").write_text(json.dumps(measures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.out / "occhio-traccia.json").write_text(json.dumps(eye_track, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(measures, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
