# Fonti di dati e immagini

Elenco delle fonti esterne usate da ATMOSPHERA, con condizioni d'uso e crediti.
Regola del progetto: solo fonti gratuite, senza chiavi a pagamento, senza registrazione con
carta di credito e senza tracciamento degli utenti.

## Texture del globo (M1)

Le immagini sono **incluse nell'app** (`public/textures/`), quindi nessuna richiesta a server
NASA o NOAA avviene durante l'uso.

| File | Origine | Elaborazione |
|---|---|---|
| `earth-day-4k.jpg` (4096×2048), `earth-day-2k.jpg` (2048×1024) | NASA Earth Observatory — *Blue Marble: Next Generation*, base map con topografia e batimetria, **ottobre** 2004, 21600×10800 (in M1: dicembre, 5400×2700) | Ridimensionata con `sips` (macOS), JPEG qualità 82 |
| `earth-night-4k.jpg` (4096×2048), `earth-night-2k.jpg` (2048×1024) | NASA Earth Observatory — *Earth at Night / Black Marble 2016*, mappa a colori 3 km (13500×6750) | Ridimensionata con `sips` (macOS), JPEG qualità 80 |

File originali (scaricati il 23/10/2026):

- (M1, non più usato) https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg
  SHA-256 `a9f0088972dee0254610af851c4d6838ca3f2cf79176987e0a5713e2c15ec042`
- https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg
  SHA-256 `230aac448ae68c358be433dd518888cccb3a85ccf66f7b44326441c324ad6725`

Pagine delle collezioni:

- https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/
- https://visibleearth.nasa.gov/images/144898/earth-at-night-black-marble-2016-color-maps
  (reindirizza alla pagina *Earth at Night/Black Marble: Flat Maps* di NASA Science)

### Condizioni d'uso

Dalle linee guida NASA *Images and Media Usage* (https://www.nasa.gov/nasa-brand-center/images-and-media/),
verificate il 23/10/2026:

- il materiale NASA, comprese le **texture usate in modelli 3D**, in genere non è soggetto a
  copyright negli Stati Uniti e può essere usato per scopi educativi o informativi, incluse
  simulazioni grafiche e pagine web;
- la NASA deve essere indicata come fonte;
- l'uso non deve far pensare a un'approvazione da parte della NASA;
- logo, insegne e identificativi NASA **non** sono liberamente utilizzabili: ATMOSPHERA non li usa.

Crediti mostrati nell'app (pannello *Informazioni*):

> Superficie: NASA Earth Observatory — Blue Marble: Next Generation, ottobre 2004.
> Luci notturne: NASA Earth Observatory — Earth at Night / Black Marble 2016 (dati Suomi NPP VIIRS).
> L'uso delle immagini NASA non implica alcuna approvazione da parte della NASA.

Nota: le pagine attuali delle collezioni non riportano una riga di credito con i nomi degli
autori, quindi l'app usa la forma istituzionale "NASA Earth Observatory".

## Evento Milton 2024 — prototipo E0

File in `public/data/events/milton-2024/`, inclusi nell'app. Procedura completa e riproducibile
in [`scripts/data/README.md`](scripts/data/README.md).

### Nuvole — NOAA GOES-16 ABI (OSSERVATO)

| | |
|---|---|
| Prodotto | ABI L2 Cloud and Moisture Imagery (CMIP), settore CONUS, modalità 6 |
| Canali | 2 (0,64 µm, visibile, 0,5 km) e 13 (10,3 µm, infrarosso, 2 km) |
| Istante | scansione iniziata il 2024-10-07 alle 20:01:17 UTC |
| Archivio | NOAA Open Data Dissemination (NODD), `s3://noaa-goes16`, accesso anonimo via HTTPS |
| Condizioni | dati del governo statunitense, accesso aperto e gratuito; attribuzione a NOAA |

File originali (scaricati il 23/10/2026):

- `OR_ABI-L2-CMIPC-M6C02_G16_s20242812001173_e20242812003546_c20242812004050.nc`
  SHA-256 `ac5a40339477c6c89cbaabf6ef903be5ad2dafe834198715d1a580a2665053f1`
- `OR_ABI-L2-CMIPC-M6C13_G16_s20242812001173_e20242812003558_c20242812004062.nc`
  SHA-256 `82e59ad531355f5ccc6ae1b29f075af4a09888da07b25d64b1c09be793d2a982`

Elaborazione (`scripts/data/goes_clouds.py`): riproiezione dalla geometria geostazionaria
(formule GOES-R PUG) a griglia lat/lon di 0,0125°, media 2×2 del canale 2, campionamento
bilineare, normalizzazione del visibile per l'angolo solare. Verifica: l'occhio di Milton
nella texture cade a 21,81° N 90,97° O, entro 8 km dalla posizione della best track.

Nel browser (vedi `src/globe/shading.ts`) le grandezze osservate diventano:

- opacità delle nubi — RICOSTRUITA con soglie sull'albedo e sulla temperatura;
- quota della sommità — RICOSTRUITA da (300 K − temperatura) / 6,5 K/km;
- rilievo, ombre, esagerazione verticale ×2 — ILLUSTRATIVI.

### Traccia — NOAA NHC HURDAT2 (OSSERVATO)

- File: `hurdat2-1851-2025-092326.txt` (Atlantico, 1851–2025, revisione 23/09/2026), da
  https://www.nhc.noaa.gov/data/hurdat/ — SHA-256 `75202780ce56c8458f16fbef5fb8a026b99b00878dbb95c458211b3e6ef125b4`
- Tempesta: AL142024 (Milton), 34 punti dal 04/10 18Z all'11/10 18Z.
- Formato: https://www.nhc.noaa.gov/data/hurdat/hurdat2-format-atlantic.pdf
- Condizioni: dati del governo statunitense, pubblico dominio; attribuzione a NOAA NHC.
- I tratti tra i punti e il "movimento" mostrato sono interpolazioni (RICOSTRUITO).

### Superficie regionale e globale — NASA Blue Marble, ottobre (OSSERVATO, composito)

- `world.topo.bathy.200410.3x21600x10800.jpg` (21600×10800, 1/60° per pixel), da
  https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/october/
  SHA-256 `af9bea6c86e684923d72842e629be0a9401d0d4f0cb76411199c8519519114ce`
- `surface.jpg`: ritaglio 100° O–68° O × 16° N–36° N (1920×1200).
- `public/textures/earth-day-{4k,2k}.jpg`: dallo stesso file (stagione coerente con l'evento);
  sostituiscono la versione di dicembre usata in M1.
- Il composito è del 2004: la superficie non è quella del 7 ottobre 2024.

## Fonti previste (non ancora integrate)

| Milestone | Fonte | Stato |
|---|---|---|
| LIVE nuvole | NASA GIBS, GOES-East (WMTS, senza chiave) | archivio di ~90 giorni verificato il 23/10/2026; non integrato |
| E2 nuvole animate | NOAA GOES-16 su NODD (come E0, più istanti) | in attesa |
| Altri cicloni | NOAA HURDAT2 / IBTrACS (pubblico dominio) | HURDAT2 in uso per Milton |
| M4 venti | Dati dimostrativi locali; Open-Meteo solo dopo verifica delle condizioni d'uso (D1) | in attesa |
| M5 navi | Fintraffic Digitraffic (CC BY 4.0) + replay storico (D2) | in attesa, nessuna API integrata |
