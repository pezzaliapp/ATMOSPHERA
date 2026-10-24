# Pipeline dati — evento Milton 2024 (E0)

Tutto gira in locale, una volta sola; i risultati sono file statici in
`public/data/events/milton-2024/`. I file grezzi scaricati restano in `data-raw/`
(escluso da Git), l'ambiente Python in `scripts/data/.venv/` (escluso da Git).
Nessun account, nessuna chiave, nessun servizio a pagamento.

## 1. Ambiente Python

```sh
python3 -m venv scripts/data/.venv
scripts/data/.venv/bin/pip install -r scripts/data/requirements.txt
```

## 2. Download (fonti pubbliche, accesso anonimo)

```sh
mkdir -p data-raw/goes16 data-raw/nasa data-raw/noaa
B=https://noaa-goes16.s3.amazonaws.com/ABI-L2-CMIPC/2024/281/20
curl -o data-raw/goes16/C02.nc $B/OR_ABI-L2-CMIPC-M6C02_G16_s20242812001173_e20242812003546_c20242812004050.nc
curl -o data-raw/goes16/C13.nc $B/OR_ABI-L2-CMIPC-M6C13_G16_s20242812001173_e20242812003558_c20242812004062.nc
curl -o data-raw/nasa/bm-200410-21600.jpg \
  https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/october/world.topo.bathy.200410.3x21600x10800.jpg
curl -o data-raw/noaa/hurdat2-1851-2025-092326.txt https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-092326.txt
```

SHA-256 attesi: vedi `DATA_SOURCES.md`.

## 3. Elaborazione

```sh
OUT=public/data/events/milton-2024
scripts/data/.venv/bin/python -I scripts/data/goes_clouds.py --c02 data-raw/goes16/C02.nc --c13 data-raw/goes16/C13.nc --out $OUT
scripts/data/.venv/bin/python -I scripts/data/bluemarble_crop.py --src data-raw/nasa/bm-200410-21600.jpg --out $OUT/surface.jpg
node scripts/data/hurdat2-track.ts data-raw/noaa/hurdat2-1851-2025-092326.txt AL142024 $OUT/track.json
```

Le texture globali `public/textures/earth-day-{2k,4k}.jpg` derivano dalla stessa Blue Marble di
ottobre, ridimensionata con `sips` (macOS).

## Regione e codifica

- Regione: 100° O – 68° O, 16° N – 36° N (limite sud dettato dal settore CONUS di GOES-16, ~14,6° N).
- Griglia nuvole: 0,0125° (≈ 1,4 km), 2560×1600, equirettangolare, riga 0 = nord.
- `clouds-albedo.jpg`: riflettanza del canale 2 / cos(zenit solare), 0–1 → 0–255.
- `clouds-bt.jpg`: temperatura di brillanza del canale 13, 180–310 K → 0–255.
- `surface.jpg`: Blue Marble ottobre 2004, 1/60° per pixel, 1920×1200.
