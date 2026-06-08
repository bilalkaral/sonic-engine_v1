const express = require('express');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static'); 
ffmpeg.setFfmpegPath(ffmpegPath);            
const MusicTempo = require('music-tempo');
const wav = require('node-wav');
const fft = require('fft-js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');// DEMUCS İÇİN EKLENDİ
const archiver = require('archiver');      // ZIPLEME İÇİN EKLENDİ
const multer = require('multer');

const app = express();
const progressMap = {}; // Demucs yüzdelerini tutmak için
const PORT = process.env.PORT || 3000;
// Sistem %TEMP% klasörünü kullan — proje klasörü adında boşluk olsa bile çalışır
const TEMP_DIR = path.join(require('os').tmpdir(), 'bpm-analyzer');
const MP3_RETENTION_MS = 30 * 60 * 1000; // stem ayırma uzun sürebildiği için kaynak mp3'ü 30 dk tut
const ID_REGEX = /^[0-9a-f-]{36}$/;       // uuid v4 doğrulaması (path traversal koruması)
const PYTHON_BIN = process.env.PYTHON || 'python'; // gerekirse PYTHON=py ile değiştirilebilir

// Key tespiti: varsayılan olarak librosa tabanlı Python analizörü kullanılır
// (tools/analyze_key.py — HPSS + CQT chroma + bas-tonik + minör prior). Python
// ya da librosa yoksa otomatik olarak dahili JS tespite (analyzeKey3Parts) düşer.
const USE_PY_KEY = process.env.USE_PY_KEY !== '0';
const KEY_SCRIPT = path.join(__dirname, 'tools', 'analyze_key.py');
const KEY_PROFILE = process.env.KEY_PROFILE || 'temperley';
const KEY_BASS = process.env.KEY_BASS || '0.5';
const KEY_MINOR = process.env.KEY_MINOR || '0.1';
const KEY_TIMEOUT_MS = 90 * 1000; // ilk çalıştırmada numba derlemesi için pay

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Yerel dosya yükleme boyut sınırı (çok büyük dosyalar diski doldurmasın).
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// ─── Temp temizleyici ──────────────────────────────────────────────────────
// Başlangıçta önceki çalışmadan kalan dosyaları sil; ayrıca periyodik süpür.
function sweepTemp(maxAgeMs) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const p = path.join(TEMP_DIR, name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch (_) {}
    }
  } catch (_) {}
}
sweepTemp(0); // başlangıçta her şeyi temizle
setInterval(() => sweepTemp(MP3_RETENTION_MS), 15 * 60 * 1000).unref();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helper: Temizlik ──────────────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}

// ─── Helper: URL Temizleyici ───────────────────────────────────────────────
function cleanYouTubeUrl(inputUrl) {
  try {
    const urlObj = new URL(inputUrl);
    if (urlObj.searchParams.has('v')) {
      return `https://www.youtube.com/watch?v=${urlObj.searchParams.get('v')}`;
    }
    if (urlObj.hostname === 'youtu.be') {
      return `https://www.youtube.com/watch?v=${urlObj.pathname.slice(1)}`;
    }
  } catch (e) {}
  return inputUrl;
}

// ─── Helper: Kurşun Geçirmez İndirme ve Dönüştürme ─────────────────────────
function downloadAndProcessAudio(youtubeUrl, mp3Path, wavPath, rawPath) {
  return new Promise(async (resolve, reject) => {
    try {
      await youtubedl(youtubeUrl, {
        format: 'bestaudio',
        output: rawPath,
        noWarnings: true,
        noCheckCertificates: true
      });

      ffmpeg(rawPath)
        .output(mp3Path)
        .audioBitrate(192)
        .format('mp3')
        .output(wavPath)
        .audioFrequency(44100)
        .audioChannels(1)
        .format('wav')
        .on('error', reject)
        .on('end', resolve)
        .run();
    } catch (error) {
      reject(error);
    }
  });
}

// ─── Helper: Milisaniye (Delay/Reverb) Hesaplayıcı ─────────────────────────
// Üretici/mix için tam tablo: straight (düz), dotted (noktalı) ve triplet
// (üçleme) süreleri. Noktalı 1/8 (dotted eighth) modern prodüksiyonda en çok
// kullanılan delay timing'idir; eski sürümde eksikti.
function calculateStudioDelays(bpm) {
  if (!bpm || bpm <= 0) return null;
  const quarter = 60000 / bpm;            // 1/4 nota (ms)
  const noteMs = denom => (quarter * 4) / denom; // 1/denom notası
  const r = v => Math.round(v * 10) / 10; // 1 ondalık hassasiyet

  const build = factor => {
    const out = {};
    [4, 8, 16, 32].forEach(d => { out[`1/${d}`] = r(noteMs(d) * factor); });
    return out;
  };

  return {
    note: build(1),       // düz
    dotted: build(1.5),   // noktalı (nota + yarısı)
    triplet: build(2 / 3) // üçleme
  };
}

// ─── Helper: BPM Tespiti (Belirli Bir Kesit İçin) ─────────────────────────
function detectBPM(audioData, sampleRate, startSec, processSecs = 10) {
  try {
    const startSample = Math.floor(startSec * sampleRate);
    const endSample = Math.floor((startSec + processSecs) * sampleRate);
    
    const slice = audioData.slice(startSample, Math.min(endSample, audioData.length));
    if (slice.length === 0) return null;
    
    const mt = new MusicTempo(Array.from(slice), { sampleRate });
    return Math.round(mt.tempo);
  } catch (e) {
    return null;
  }
}

// ─── Helper: Tempo Oktav Normalizasyonu ───────────────────────────────────
// Sonucu "hissedilen tempo" penceresine [MIN, MAX) katlar. Benchmark verisi
// (tools/benchmark.js) gösterdi ki music-tempo yavaş parçaları (88-98 BPM
// boom-bap/lo-fi) sıklıkla İKİYE KATLIYOR → çiftlenmeler 176+ değerinde toplanır
// (88×2=176, 90×2=180). Eşik 175: hızlı trap (168) ve DnB (174) KORUNUR, ama
// 176+ alt-bölünme hataları yarıya katlanır. Belirsiz durumlar için arayüzdeki
// ½/2× çipleri var. TEMPO_MIN/TEMPO_MAX ile özelleştirilebilir.
const FELT_TEMPO_MIN = Number(process.env.TEMPO_MIN) || 70;
const FELT_TEMPO_MAX = Number(process.env.TEMPO_MAX) || 175;
function normalizeTempo(bpm) {
  if (!bpm || bpm <= 0) return bpm;
  let b = bpm;
  while (b < FELT_TEMPO_MIN) b *= 2;
  while (b >= FELT_TEMPO_MAX) b /= 2;
  return Math.round(b);
}

// ─── Helper: 3 Farklı Noktadan BPM Analizi ve Çözücü ──────────────────────
function analyzeBPM3Parts(audioData, sampleRate) {
  const durationSecs = audioData.length / sampleRate;

  if (durationSecs < 15) {
      const bpm = detectBPM(audioData, sampleRate, 0, durationSecs);
      return normalizeTempo(bpm);
  }

  const p1 = durationSecs * 0.25;
  const p2 = durationSecs * 0.50;
  const p3 = durationSecs * 0.75;

  const bpm1 = detectBPM(audioData, sampleRate, p1, 10);
  const bpm2 = detectBPM(audioData, sampleRate, p2, 10);
  const bpm3 = detectBPM(audioData, sampleRate, p3, 10);

  const validBpms = [bpm1, bpm2, bpm3].filter(b => b !== null);
  if (validBpms.length === 0) return null;

  const tolerance = 3; 
  let clusters = [];

  validBpms.forEach(bpm => {
      let matched = false;
      for (let cluster of clusters) {
          let base = cluster.baseBpm;
          if (
              Math.abs(bpm - base) <= tolerance || 
              Math.abs(bpm * 2 - base) <= tolerance || 
              Math.abs(bpm - base * 2) <= tolerance
          ) {
              cluster.values.push(bpm);
              cluster.baseBpm = Math.max(...cluster.values);
              matched = true;
              break;
          }
      }
      if (!matched) clusters.push({ baseBpm: bpm, values: [bpm] });
  });

  clusters.sort((a, b) => b.values.length - a.values.length);
  const finalBpm = clusters[0].baseBpm;

  return normalizeTempo(finalBpm);
}

// ─── Helper: Enharmonik Normalizasyon ─────────────────────────────────────
function normalizeEnharmonic(key) {
  const map = { 'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#' };
  return map[key] || key;
}

// ─── Camelot Wheel (Harmonik Mix Referansı) ───────────────────────────────
// "<kök> <Major|Minor>" → Camelot kodu. Aynı sayıyı paylaşan iki anahtar
// (ör. 8A/8B) relative major/minor olup armonik olarak uyumludur.
const CAMELOT = {
  'C Major': '8B',  'A Minor': '8A',
  'G Major': '9B',  'E Minor': '9A',
  'D Major': '10B', 'B Minor': '10A',
  'A Major': '11B', 'F# Minor': '11A',
  'E Major': '12B', 'C# Minor': '12A',
  'B Major': '1B',  'G# Minor': '1A',
  'F# Major': '2B', 'D# Minor': '2A',
  'C# Major': '3B', 'A# Minor': '3A',
  'G# Major': '4B', 'F Minor': '4A',
  'D# Major': '5B', 'C Minor': '5A',
  'A# Major': '6B', 'G Minor': '6A',
  'F Major': '7B',  'D Minor': '7A'
};

function camelotOf(key, scale) {
  return CAMELOT[`${key} ${scale}`] || '';
}

// İki anahtar relative mi? (Aynı Camelot sayısı = aynı notalar, farklı mod)
function areRelative(a, b) {
  const ca = CAMELOT[a], cb = CAMELOT[b];
  if (!ca || !cb || ca === cb) return false;
  return ca.slice(0, -1) === cb.slice(0, -1);
}

// ─── Helper: Nota (Key) ve Mod Tespiti ────────────────────────────────────
function detectKey(audioData, sampleRate, startSec = 0, processSecs = 15) {
  try {
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.97, 2.49, 5.21, 3.62, 2.59, 1.93, 3.68];
    const PROFILES = { 'Major': MAJOR, 'Minor': MINOR };

    // 16384 örnek → ~2.7 Hz/bin: bas oktavındaki yarım-ton aralığını (~4 Hz) çözebilir.
    const chunkSize = Math.pow(2, 14);
    // Hann penceresi: FFT öncesi spektral sızıntıyı azaltır (önceden HİÇ yoktu,
    // bu da chroma'yı bozan en büyük etkenlerden biriydi).
    const hann = new Float32Array(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (chunkSize - 1));
    }

    const chromaBass = new Array(12).fill(0);
    const chromaMid  = new Array(12).fill(0);
    let chunksProcessed = 0;

    const startSample = Math.floor(startSec * sampleRate);
    const maxSamples = Math.min(audioData.length, startSample + (sampleRate * processSecs));
    const hop = chunkSize >> 1;             // %50 örtüşme → daha kararlı chroma
    const freqPerBin = sampleRate / chunkSize;

    for (let start = startSample; start + chunkSize < maxSamples; start += hop) {
      const windowed = new Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) windowed[i] = audioData[start + i] * hann[i];

      const phasors = fft.fft(windowed);
      const magnitudes = fft.util.fftMag(phasors);

      for (let i = 1; i < magnitudes.length / 2; i++) {
        const freq = i * freqPerBin;
        if (freq < 65 || freq > 2000) continue;

        // sqrt-sıkıştırma: yüksek enerjili vurmalı/transient binlerin baskınlığını
        // kırar, tonal içeriğe daha adil ağırlık verir.
        const mag = Math.sqrt(magnitudes[i]);

        const midiNote = 12 * Math.log2(freq / 440) + 69;
        const noteFloor = Math.floor(midiNote);
        const fraction = midiNote - noteFloor;

        const chroma1 = ((noteFloor % 12) + 12) % 12;
        const chroma2 = (chroma1 + 1) % 12;

        if (freq <= 300) {
          chromaBass[chroma1] += mag * (1 - fraction) * 3.5;
          chromaBass[chroma2] += mag * fraction * 3.5;
        } else {
          chromaMid[chroma1] += mag * (1 - fraction);
          chromaMid[chroma2] += mag * fraction;
        }
      }
      chunksProcessed++;
    }

    if (chunksProcessed === 0) return { key: 'Unknown', scale: '', score: 0, confident: false };

    const chromaRaw = chromaBass.map((v, i) => v + chromaMid[i]);
    const maxChroma = Math.max(...chromaRaw);
    const chroma = chromaRaw.map(v => v / maxChroma);

    let scores = [];

    for (let root = 0; root < 12; root++) {
      for (const mode of Object.keys(PROFILES)) {
        const profile = PROFILES[mode];
        
        let mMean = chroma.reduce((a, b) => a + b, 0) / 12;
        let profMean = profile.reduce((a, b) => a + b, 0) / 12;
        let mNum = 0, majDen = 0, minDen = 0;

        for (let i = 0; i < 12; i++) {
          const ci = chroma[(i + root) % 12];
          const pi = profile[i];
          mNum += (ci - mMean) * (pi - profMean);
          majDen += Math.pow(ci - mMean, 2);
          minDen += Math.pow(pi - profMean, 2);
        }

        const score = mNum / Math.sqrt(majDen * minDen + 1e-10);
        scores.push({ root, mode, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const second = scores[1];
    const gap = best.score - second.score;
    const confident = gap >= 0.05;

    const keyName = normalizeEnharmonic(NOTE_NAMES[best.root]);
    const candidates = scores.slice(0, 3).map(s => ({
      key: normalizeEnharmonic(NOTE_NAMES[s.root]),
      scale: s.mode
    }));
    return {
      key: keyName,
      scale: best.mode,
      camelot: camelotOf(keyName, best.mode),
      score: best.score,
      confident,
      gap,
      candidates,
      altKey: normalizeEnharmonic(NOTE_NAMES[second.root]),
      altScale: second.mode,
      altGap: gap
    };
  } catch (e) {
    return { key: 'Unknown', scale: '', score: 0, confident: false };
  }
}

// ─── Helper: 5 Noktadan Key Analizi ───────────────────────────────────────
function analyzeKey3Parts(audioData, sampleRate) {
  const durationSecs = audioData.length / sampleRate;
  
  if (durationSecs < 15) {
    return detectKey(audioData, sampleRate, 0, durationSecs);
  }

  const points = [0.08, 0.25, 0.50, 0.75, 0.92];
  const results = points.map(p => detectKey(audioData, sampleRate, durationSecs * p, 15));

  const allKeys = results.filter(k => k && k.key !== 'Unknown');
  if (allKeys.length === 0) return { key: 'Unknown', scale: '' };

  const votes = {};
  allKeys.forEach(k => {
    const str = `${k.key} ${k.scale}`;
    const weight = k.confident ? 2 : 1;
    votes[str] = (votes[str] || 0) + weight;
  });

  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [winner, winnerVotes] = sorted[0];
  const [runnerUp, runnerUpVotes] = sorted[1] || [null, 0];

  if (runnerUp && (winnerVotes - runnerUpVotes) <= 2 && areRelative(winner, runnerUp)) {
    
    const rootCount = {};
    allKeys.forEach(k => {
      rootCount[k.key] = (rootCount[k.key] || 0) + (k.confident ? 2 : 1);
    });
    
    const winnerRoot = winner.split(' ')[0];
    const runnerRoot = runnerUp.split(' ')[0];
    const winnerRootScore = rootCount[winnerRoot] || 0;
    const runnerRootScore = rootCount[runnerRoot] || 0;

    const tiebreakWinner = runnerRootScore > winnerRootScore ? runnerUp : winner;
    return allKeys.find(k => `${k.key} ${k.scale}` === tiebreakWinner) || allKeys[0];
  }

  const isClose = runnerUp && (winnerVotes - runnerUpVotes) <= 2;
  const winnerResult = allKeys.find(k => `${k.key} ${k.scale}` === winner) || allKeys[0];

  if (isClose) {
    return { ...winnerResult, alt_key: runnerUp };
  }

  return winnerResult;
}

// ─── Helper: librosa tabanlı harici key tespiti (Python) ──────────────────
// Başarılı olursa {key, scale, camelot, confident} döner; Python/librosa yoksa,
// hata olursa veya zaman aşımına uğrarsa null döner (çağıran JS'e düşer).
function detectKeyExternal(wavPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let proc;
    try {
      proc = spawn(PYTHON_BIN, [KEY_SCRIPT, wavPath, KEY_PROFILE, KEY_BASS, KEY_MINOR], { shell: false });
    } catch (_) {
      return done(null);
    }

    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} done(null); }, KEY_TIMEOUT_MS);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); done(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const line = out.trim().split('\n').pop();
        const j = JSON.parse(line);
        if (j && j.key && !j.error) {
          j.camelot = camelotOf(j.key, j.scale);
          return done(j);
        }
      } catch (_) {}
      done(null);
    });
  });
}

// ─── Helper: WAV'ı çöz ve analiz et ───────────────────────────────────────
async function runAnalysis(wavPath) {
  const wavBuffer = fs.readFileSync(wavPath);
  const decoded = wav.decode(wavBuffer);
  const audioData = decoded.channelData[0];
  const sampleRate = decoded.sampleRate;

  const bpm = analyzeBPM3Parts(audioData, sampleRate);

  // Önce librosa (daha doğru); olmazsa dahili JS tespite düş.
  let keyInfo = null;
  let keySource = 'js';
  if (USE_PY_KEY) {
    const ext = await detectKeyExternal(wavPath);
    if (ext) { keyInfo = ext; keySource = 'librosa'; }
  }
  if (!keyInfo) keyInfo = analyzeKey3Parts(audioData, sampleRate);
  if (keyInfo) keyInfo.source = keySource;

  return { bpm, keyInfo };
}

// ─── Helper: Ortak yanıt nesnesi (iki analiz rotası da kullanır) ──────────
function buildResult(id, meta, bpm, keyInfo) {
  const hasKey = keyInfo && keyInfo.key && keyInfo.key !== 'Unknown';
  const primaryStr = hasKey ? `${keyInfo.key} ${keyInfo.scale}` : '';

  // Aday key'ler (Camelot'larıyla) — düşük güvende kullanıcıya alternatif sunmak için.
  const cands = (keyInfo && Array.isArray(keyInfo.candidates)) ? keyInfo.candidates : [];
  const keyAlts = cands
    .map(c => ({ key: `${c.key} ${c.scale}`, camelot: camelotOf(c.key, c.scale) }))
    .filter(c => c.key !== primaryStr)
    .slice(0, 2);

  return {
    success: true,
    downloadId: id,
    bpm: bpm || 'N/A',
    bpmAlts: bpm ? { half: Math.round(bpm / 2), double: bpm * 2 } : null,
    key: hasKey ? primaryStr : 'N/A',
    camelot: hasKey ? (keyInfo.camelot || '') : '',
    confident: hasKey ? !!keyInfo.confident : false,
    keySource: keyInfo && keyInfo.source ? keyInfo.source : 'js',
    keyAlts: keyAlts,
    delays_ms: calculateStudioDelays(bpm),
    title: meta.title,
    thumbnail: meta.thumbnail,
    duration: meta.duration,
    author: meta.author
  };
}

// ─── GET /video-info ───────────────────────────────────────────────────────
app.get('/video-info', async (req, res) => {
  let { url } = req.query;
  url = cleanYouTubeUrl(url);

  try {
    const info = await youtubedl(url, { dumpJson: true, noWarnings: true });
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader,
    });
  } catch (e) {
    res.status(400).json({ error: 'Geçersiz veya kısıtlanmış YouTube URL' });
  }
});
// ─── GET /progress/:id ────────────────────────────────────────────────────
app.get('/progress/:id', (req, res) => {
  res.json({ progress: progressMap[req.params.id] || 0 });
});

// ─── POST /analyze (YENİDEN EKLENDİ) ──────────────────────────────────────
app.post('/analyze', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'YouTube URL is required.' });
  
  url = cleanYouTubeUrl(url);
  const id = uuidv4();
  const rawPath = path.join(TEMP_DIR, `${id}_raw.webm`);
  const mp3Path = path.join(TEMP_DIR, `${id}.mp3`);
  const wavPath = path.join(TEMP_DIR, `${id}.wav`);

  try {
    const info = await youtubedl(url, { dumpJson: true, noWarnings: true });
    await downloadAndProcessAudio(url, mp3Path, wavPath, rawPath);

    const { bpm, keyInfo } = await runAnalysis(wavPath);

    res.json(buildResult(id, {
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      author: info.uploader
    }, bpm, keyInfo));

    cleanup(rawPath, wavPath);
    setTimeout(() => cleanup(mp3Path), MP3_RETENTION_MS);

  } catch (error) {
    console.error(`[${id}] Analyze Error:`, error);
    cleanup(rawPath, wavPath, mp3Path);
    res.status(500).json({ success: false, error: 'Ses işlenirken bir hata oluştu.' });
  }
});

// ─── POST /analyze-file (YEREL DOSYA) ─────────────────────────────────────
app.post('/analyze-file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  
  const id = uuidv4();
  const rawPath = req.file.path;
  const mp3Path = path.join(TEMP_DIR, `${id}.mp3`);
  const wavPath = path.join(TEMP_DIR, `${id}.wav`);
  const originalName = req.file.originalname || 'Local_File';

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .output(mp3Path)
        .audioBitrate(192)
        .format('mp3')
        .output(wavPath)
        .audioFrequency(44100)
        .audioChannels(1)
        .format('wav')
        .on('error', reject)
        .on('end', resolve)
        .run();
    });

    const { bpm, keyInfo } = await runAnalysis(wavPath);

    res.json(buildResult(id, {
      title: originalName,
      thumbnail: null,
      duration: 0,
      author: 'Local Upload'
    }, bpm, keyInfo));

    cleanup(rawPath, wavPath);
    setTimeout(() => cleanup(mp3Path), MP3_RETENTION_MS);

  } catch (error) {
    console.error(`[${id}] Analyze Error:`, error);
    cleanup(rawPath, wavPath, mp3Path);
    res.status(500).json({ success: false, error: 'Ses işlenirken bir hata oluştu.' });
  }
});

// ─── POST /stems (DEMUCS VERSİYONU) ───────────────────────────────────────
app.post('/stems', async (req, res) => {
  const { downloadId, type } = req.body;
  if (!downloadId || !ID_REGEX.test(downloadId)) {
    return res.status(400).json({ error: 'Geçersiz ID' });
  }
  if (type !== 'all' && type !== 'vocals') {
    return res.status(400).json({ error: 'Geçersiz stem tipi' });
  }

  const mp3Path = path.join(TEMP_DIR, `${downloadId}.mp3`);
  const stemsOutputDir = path.join(TEMP_DIR, `stems_${downloadId}`);
  const zipPath = path.join(TEMP_DIR, `${downloadId}_stems.zip`);

  if (!fs.existsSync(mp3Path)) {
    return res.status(404).json({ error: 'Ses dosyası bulunamadı. Lütfen önce analiz edin.' });
  }

  try {
    console.log(`[${downloadId}] Demucs ile stem ayırma başladı...`);
    
await new Promise((resolve, reject) => {
      progressMap[downloadId] = 0; // Başlangıç yüzdesini sıfırla

      let errorLog = '';
      const demucsArgs = [
        '-m', 'demucs',
        '-n', 'htdemucs',
        '--mp3',
        '-o', stemsOutputDir,
        mp3Path
      ];
      if (type === 'vocals') {
        demucsArgs.push('--two-stems', 'vocals');
      }

      const demucsProcess = spawn(PYTHON_BIN, demucsArgs, {
        shell: false
      });

      demucsProcess.stdout.on('data', (data) => {
        process.stdout.write(`[Demucs] ${data}`);
      });

      demucsProcess.stderr.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(`[Demucs] ${output}`);
        errorLog += output;
        const match = output.match(/(\d+)%/);
        if (match) {
          progressMap[downloadId] = parseInt(match[1], 10);
        }
      });

      demucsProcess.on('error', (err) => {
        reject(new Error(`Python baslatılamadi: ${err.message}`));
      });

      demucsProcess.on('close', (code) => {
        delete progressMap[downloadId];
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Demucs hata kodu ${code}: ${errorLog.slice(-500)}`));
        }
      });
    });
    console.log(`[${downloadId}] Demucs işlemi bitti...`);

    if (type === 'vocals') {
      const vocalsSrc = path.join(stemsOutputDir, 'htdemucs', downloadId, 'vocals.mp3');
      const instSrc = path.join(stemsOutputDir, 'htdemucs', downloadId, 'no_vocals.mp3');
      const vocalsDest = path.join(TEMP_DIR, `${downloadId}_vocals.mp3`);
      const instDest = path.join(TEMP_DIR, `${downloadId}_instrumental.mp3`);
      
      try {
        fs.renameSync(vocalsSrc, vocalsDest);
        fs.renameSync(instSrc, instDest);
      } catch(e) {}
      
      res.json({ 
        success: true, 
        vocalsUrl: `/download-direct/${downloadId}/vocals?dummy=1`, 
        instrumentalUrl: `/download-direct/${downloadId}/instrumental?dummy=1` 
      });
      
      fs.rmSync(stemsOutputDir, { recursive: true, force: true });
      setTimeout(() => { cleanup(vocalsDest, instDest); }, 10 * 60 * 1000);
    } else {
      console.log(`[${downloadId}] ZIP oluşturuluyor...`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log(`[${downloadId}] ZIP hazır: ${archive.pointer()} bytes`);
        res.json({ success: true, zipUrl: `/download-zip/${downloadId}` });
        
        fs.rmSync(stemsOutputDir, { recursive: true, force: true });
        setTimeout(() => cleanup(zipPath), 10 * 60 * 1000);
      });

      archive.on('error', (err) => {
        console.error(`[${downloadId}] ZIP hatası:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'ZIP oluşturulamadı.' });
      });
      archive.pipe(output);
      
      const targetDir = path.join(stemsOutputDir, 'htdemucs', downloadId);
      archive.directory(targetDir, false);
      await archive.finalize();
    }

  } catch (err) {
    console.error(`[${downloadId}] Stem ayırma başarısız:`, err);
    res.status(500).json({ error: 'Stem ayırma işlemi başarısız oldu.' });
  }
});

// ─── GET /download-direct/:id/:type ───────────────────────────────────────
app.get('/download-direct/:id/:type', (req, res) => {
  const { id, type } = req.params;
  if (!ID_REGEX.test(id) || (type !== 'vocals' && type !== 'instrumental')) {
    return res.status(400).send('Geçersiz istek');
  }
  const title = req.query.title || 'Track';
  const filePath = path.join(TEMP_DIR, `${id}_${type}.mp3`);

  if (!fs.existsSync(filePath)) return res.status(404).send('Stem dosyası bulunamadı veya süresi doldu.');
  
  res.download(filePath, `${title} - ${type === 'vocals' ? 'Acapella' : 'Instrumental'}.mp3`);
});

// ─── GET /download-zip/:id ────────────────────────────────────────────────
app.get('/download-zip/:id', (req, res) => {
  const { id } = req.params;
  if (!ID_REGEX.test(id)) return res.status(400).send('Geçersiz istek');
  // URL'den gelen başlığı al, gelmezse varsayılan bir isim kullan
  const title = req.query.title || 'Demucs_Stems';
  const zipPath = path.join(TEMP_DIR, `${id}_stems.zip`);

  if (!fs.existsSync(zipPath)) return res.status(404).send('ZIP dosyası bulunamadı veya süresi doldu.');
  
  // Dosyayı "Video Başlığı - Stemler.zip" formatında indir
  res.download(zipPath, `${title} - Stems.zip`);
});

// ─── GET /download/:id ────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  const fileName = req.query.name || 'audio.mp3'; 

  if (!ID_REGEX.test(id)) return res.status(400).send('Invalid ID');
  const mp3Path = path.join(TEMP_DIR, `${id}.mp3`);
  if (!fs.existsSync(mp3Path)) return res.status(404).send('File not found or expired');
  
  res.download(mp3Path, fileName);
});

// Yalnızca doğrudan çalıştırıldığında dinle (test için require edilebilsin).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎵 YouTube BPM Analyzer running at http://localhost:${PORT}\n`);
  });
}

// Saf yardımcıları test/yeniden kullanım için dışa aktar.
module.exports = {
  app,
  normalizeTempo,
  normalizeEnharmonic,
  calculateStudioDelays,
  camelotOf,
  areRelative,
  detectKey,
  detectBPM,
  analyzeBPM3Parts,
  analyzeKey3Parts,
  runAnalysis,
  downloadAndProcessAudio,
  cleanYouTubeUrl
};