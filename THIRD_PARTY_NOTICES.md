# Componenti di terze parti

ATMOSPHERA è rilasciata con licenza MIT (vedi [LICENSE](LICENSE)), © 2026 Alessandro Pezzali.
Questo file elenca il codice di terze parti **incluso nell'applicazione pubblicata** e gli
strumenti usati solo per lo sviluppo. Le fonti di dati e immagini sono in [DATA_SOURCES.md](DATA_SOURCES.md).

Nessun componente del progetto Airsup Lab è stato importato.

## Incluso nell'applicazione (bundle e service worker)

| Componente | Versione | Licenza | Copyright | Provenienza |
|---|---|---|---|---|
| three.js | 0.186.1 | MIT | © 2010-2026 three.js authors | https://github.com/mrdoob/three.js |
| workbox-window | 7.4.1 | MIT | © 2018 Google LLC | https://github.com/GoogleChrome/workbox |
| Workbox runtime (core, precaching, routing, strategies, expiration), generato da `workbox-build` | 7.4.x | MIT | © 2018 Google LLC | https://github.com/GoogleChrome/workbox |

### Testo della licenza MIT (three.js)

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Testo della licenza MIT (Workbox)

```
Copyright 2018 Google LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Solo sviluppo (non inclusi nell'applicazione pubblicata)

Tutti installati dal registry ufficiale npm, a versione fissata (`package-lock.json`).

| Pacchetto | Versione | Licenza |
|---|---|---|
| vite | 8.3.4 | MIT |
| vite-plugin-pwa | 2.0.0 | MIT |
| vitest | 5.0.3 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| @types/three | 0.186.0 | MIT |

Strumenti Python per l'elaborazione dei dati (ambiente locale `scripts/data/.venv`, escluso da Git,
versioni in `scripts/data/requirements.txt`):

| Pacchetto | Versione | Licenza |
|---|---|---|
| numpy | 2.5.3 | BSD-3-Clause (con componenti 0BSD, MIT, Zlib, CC0-1.0) |
| h5py | 3.16.0 | BSD-3-Clause |
| Pillow | 12.3.0 | MIT-CMU |
| opencv-python-headless | 4.14.0.94 | Apache-2.0; il pacchetto include FFmpeg (LGPL-2.1), libjpeg-turbo, libpng e altri componenti elencati nel suo `LICENSE-3RD-PARTY.txt`. Usato solo per calcolare il campo di moto delle nuvole; nulla di OpenCV entra nell'app. Wheel verificata con SHA-256 `bc7db37dc234f7bb3190a158fd9dd750357246fc7d8adb23698843ef721a993b` (PyPI). |

Le dipendenze transitive degli strumenti di sviluppo includono pacchetti MIT, ISC, BSD,
Apache-2.0 e BlueOak-1.0.0, più `lightningcss` (MPL-2.0, usato da Vite per il CSS) e
`caniuse-lite` (CC-BY-4.0, dati di compatibilità dei browser). Nessuno di essi viene
distribuito con l'applicazione.

## Asset originali

Icone dell'app (`public/icons/*`, `public/favicon.svg`), icone dell'interfaccia
(`src/ui/icons.ts`), shader (superficie, atmosfera, nuvole, traccia), controller di camera,
script di elaborazione dati e campo stellare procedurale sono opere originali di questo
progetto, coperte dalla licenza MIT. Le icone PNG sono generate da `scripts/generate-icons.mjs`.
