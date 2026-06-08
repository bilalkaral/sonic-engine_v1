#!/usr/bin/env python3
"""
Gelişmiş key tespiti — librosa tabanlı.

Yöntem:
  * Parçanın ORTA ~60 sn'si (key sabittir → hız).
  * HPSS ile perkasyonu çıkar (temiz tonal içerik).
  * chroma_cqt (Constant-Q): log-frekans + otomatik tuning düzeltme.
  * Mod (major/minor) ve kök için 24-key profil korelasyonu.
  * BAS-TONİK BİASLAMA: trap/drill gibi bas-merkezli müzikte tonik neredeyse
    her zaman 808/bas notasıdır. Düşük register chroma'sından baskın pitch
    sınıfını bulup, toniği o olan key'leri ödüllendiririz. Bu, "dörtlü/
    subdominant karışması" (Gm→Cm gibi) hatalarını büyük ölçüde giderir.

Kullanım:
  python tools/analyze_key.py <ses.wav|mp3> [profil] [bass_weight]
  profil ∈ {krumhansl, temperley, albrecht}  (varsayılan: albrecht)
Çıktı: tek satır JSON  {key, scale, score, confident, profile}  | hata: {error}
"""
import sys
import json
import warnings
warnings.filterwarnings("ignore")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

PROFILES = {
    "krumhansl": (
        [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
        [6.33, 2.68, 3.52, 5.38, 2.60, 3.97, 2.49, 5.21, 3.62, 2.59, 1.93, 3.68]),
    "temperley": (
        [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
        [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330]),
    "albrecht": (
        [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.080, 0.008, 0.081],
        [0.220, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052]),
}

SEGMENT_SECS = 60
# Benchmark (tools/bench_key.py) ile seçilen en iyi konfigürasyon:
#   temperley + bass=0.5 + minor=0.1  →  %62.5 tam isabet (n=24)
DEFAULT_PROFILE = "temperley"
DEFAULT_BASS_WEIGHT = 0.5
# Tür önyargısı: bu aracın hedef kitlesi (trap/drill/hip-hop) ~%90 minördür.
# Modest bir minör ödülü, "doğru kök ama yanlış mod" hatalarını düzeltir.
DEFAULT_MINOR_BIAS = 0.1


def chroma_vectors(path):
    """Pahalı kısım (dosya başına 1 kez): (full_chroma_vec, bass_pc_dağılımı)."""
    import numpy as np
    import librosa

    y, sr = librosa.load(path, sr=22050, mono=True)
    if y is None or y.size == 0:
        raise ValueError("empty audio")

    total = y.shape[0]
    seg = SEGMENT_SECS * sr
    if total > seg:
        start = (total - seg) // 2
        y = y[start:start + seg]

    y_h = librosa.effects.harmonic(y, margin=8.0)

    full = librosa.feature.chroma_cqt(y=y_h, sr=sr, bins_per_octave=36)
    vec = np.mean(full, axis=1)
    vec = vec / (np.linalg.norm(vec) + 1e-9)

    # Bas register chroma'sı (~C1–C4): tonik adayı için
    bass = librosa.feature.chroma_cqt(
        y=y_h, sr=sr, bins_per_octave=36,
        fmin=librosa.note_to_hz('C1'), n_octaves=3)
    bvec = np.mean(bass, axis=1)
    bvec = bvec / (bvec.sum() + 1e-9)        # dağılım (toplam=1)
    return vec, bvec


def key_from_vectors(vec, bvec, profile_name=DEFAULT_PROFILE,
                     bass_weight=DEFAULT_BASS_WEIGHT, minor_bias=DEFAULT_MINOR_BIAS):
    """Ucuz kısım: profil korelasyonu + bas-tonik biaslama + minör önyargısı."""
    import numpy as np
    maj, minp = PROFILES.get(profile_name, PROFILES[DEFAULT_PROFILE])
    maj = np.array(maj, dtype=float)
    minp = np.array(minp, dtype=float)

    def pearson(a, b):
        a = a - a.mean()
        b = b - b.mean()
        d = np.sqrt((a * a).sum() * (b * b).sum()) + 1e-12
        return float((a * b).sum() / d)

    scored = []
    for root in range(12):
        tonic_bonus = float(bvec[root]) * bass_weight
        s_maj = pearson(vec, np.roll(maj, root)) + tonic_bonus
        s_min = pearson(vec, np.roll(minp, root)) + tonic_bonus + minor_bias
        scored.append((s_maj, root, "Major"))
        scored.append((s_min, root, "Minor"))
    scored.sort(reverse=True)
    best, second = scored[0], scored[1]
    candidates = [{"key": NOTE[r], "scale": m} for (_, r, m) in scored[:3]]
    return {
        "key": NOTE[best[1]],
        "scale": best[2],
        "score": round(best[0], 4),
        "confident": bool(best[0] - second[0] >= 0.04),
        "candidates": candidates,
        "profile": profile_name
    }


def analyze_file(path, profile_name=DEFAULT_PROFILE,
                 bass_weight=DEFAULT_BASS_WEIGHT, minor_bias=DEFAULT_MINOR_BIAS):
    vec, bvec = chroma_vectors(path)
    return key_from_vectors(vec, bvec, profile_name, bass_weight, minor_bias)


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "usage: analyze_key.py <audio> [profile] [bass_weight]"}))
        return
    path = args[0]
    profile_name = args[1].lower() if len(args) > 1 else DEFAULT_PROFILE
    bass_weight = float(args[2]) if len(args) > 2 else DEFAULT_BASS_WEIGHT
    minor_bias = float(args[3]) if len(args) > 3 else DEFAULT_MINOR_BIAS
    try:
        print(json.dumps(analyze_file(path, profile_name, bass_weight, minor_bias)))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
