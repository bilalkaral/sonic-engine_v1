# Sonic Engine — BPM, Key & Stem Analyzer

Analyze **tempo (BPM)**, **musical key** (+ **Camelot** code) and studio **delay timings** from any YouTube link or local audio/video file. Also separates tracks into stems (acapella, instrumental, or 4-stem ZIP) using **Demucs** — runs entirely on your machine, no cloud needed.

![Node.js](https://img.shields.io/badge/Node.js-Express-green) ![Python](https://img.shields.io/badge/Python-librosa%20%7C%20Demucs-blue) ![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)

---

## Features

- **BPM detection** — samples the track at multiple points, clusters results, and corrects octave errors with "felt tempo" normalization
- **½ / 2× tempo chips** — let you fix octave ambiguity; delay table updates instantly
- **Key detection** — defaults to a **librosa** engine (HPSS + Constant-Q chroma + bass-tonic bias + genre prior); automatically falls back to a pure-JS detector if Python/librosa is unavailable
- **Camelot Wheel** — harmonic mixing reference (e.g. `A Minor → 8A`)
- **Low-confidence key chips** — when the engine is uncertain, shows the top 2–3 candidate keys as clickable chips
- **Studio delay table** — Note / Dotted / Triplet × 1/4…1/32, in ms + LFO Hz sync
- **Stem separation (Demucs htdemucs)** — 4-stem ZIP *or* separate acapella + instrumental MP3s
- **Local file support** — drag & drop any audio/video file instead of a YouTube link
- **Auto temp cleanup** — MP3s expire after 30 min, stem files after 10 min

---

## Architecture

```
Browser (public/index.html)
        │  fetch
        ▼
Node + Express (server.js)
   ├── yt-dlp ───────────► audio download (YouTube)
   ├── ffmpeg ──────────► mp3 + wav conversion
   ├── BPM / delays ────► JS DSP (FFT, music-tempo)
   ├── Key ─────────────► Python: tools/analyze_key.py (librosa)
   │                              ↘ fallback: JS chroma
   └── Stem separation ─► Python: demucs (htdemucs model)
```

---

## Quick Start (Windows)

### 1. First-time setup (run once)

Double-click **`KURULUM.bat`** — automatically installs Node.js, Python, FFmpeg, npm packages, PyTorch (CPU), Demucs, yt-dlp and librosa. Requires internet, takes 10–20 min.

### 2. Launch

Double-click **`CALISTIR.bat`** — browser opens automatically at `http://localhost:3000`.

### Manual setup

```bash
npm install
python -m pip install librosa soundfile demucs yt-dlp torch torchaudio --index-url https://download.pytorch.org/whl/cpu
node server.js
```

---

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `PYTHON` | `python` | Python command (`py` if needed) |
| `USE_PY_KEY` | `1` | Set `0` to disable librosa, use JS key only |
| `KEY_PROFILE` | `temperley` | Key profile: `krumhansl` / `temperley` / `albrecht` |
| `KEY_BASS` | `0.5` | Bass-tonic bias weight |
| `KEY_MINOR` | `0.1` | Minor bias (trap/drill is ~90% minor) |
| `TEMPO_MIN` | `70` | Felt tempo lower bound |
| `TEMPO_MAX` | `175` | Felt tempo upper bound |

---

## Project Structure

```
bpm_v2/
├── server.js              Express server + JS DSP (BPM, delay, JS key fallback)
├── public/
│   └── index.html         Single-page UI
├── tools/
│   └── analyze_key.py     librosa key engine (called by the server)
├── KURULUM.bat            First-time installer (Windows)
├── CALISTIR.bat           App launcher (Windows)
├── package.json
└── .gitignore
```

---

## Accuracy

| Metric | Baseline | Improved JS | librosa engine |
|---|---|---|---|
| **BPM** exact match (±2) | 30% | **90%** | — |
| **BPM** incl. octave | 85% | **90.8%** (n=65) | — |
| **KEY** exact match | 28.6% | 54.2% | **62.5%** (n=24) |

> Key detection from raw audio is inherently hard. Classical methods plateau around 55–65% on bass-heavy trap/drill content. A trained deep learning model would be needed to push further.

---

## License

MIT — free for personal and commercial use. Demucs, PyTorch and yt-dlp are subject to their own licenses.
