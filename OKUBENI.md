# BPM & Stem Analyzer — Kullanım Rehberi

YouTube linkinden veya bilgisayarındaki ses/video dosyasından **tempo (BPM)**, **müzikal key** ve stüdyo **delay süreleri** çıkaran; ayrıca **stem ayırma** (akapella, enstrümantal veya 4 ayrı parça) yapan yerel bir araç.

---

## Klasör Yapısı

Tüm dosyalar aynı klasörde olmalı:

```
BPM-Analyzer/
   ├── server.js
   ├── package.json
   ├── public/              ← arayüz dosyaları
   ├── tools/
   │   └── analyze_key.py   ← gelişmiş key tespiti
   ├── KURULUM.bat          ← İlk kurulum (1 kez çalıştır)
   └── CALISTIR.bat         ← Her seferinde bu ile aç
```

---

## Kurulum (3 adım)

### 1. İlk Kurulum (sadece 1 kez)

`KURULUM.bat` dosyasına **çift tıkla** → siyah pencere açılır, tüm kurulum otomatik yapılır.
İnternet bağlantısı gerekli. 10–20 dakika sürebilir.

> **"Bu uygulama güvenilir değil" uyarısı çıkarsa:**
> **"Daha fazla bilgi" → "Yine de çalıştır"** tıkla

### 2. Uygulamayı Başlat

`CALISTIR.bat` dosyasına **çift tıkla** → tarayıcı otomatik açılır.

### 3. Kullan

- **YouTube** → URL'yi yapıştır → **Analyze URL**
- **Yerel dosya** → "Drop audio/video file here" butonuna tıkla veya dosyayı sürükle-bırak

---

## Özellikler

| Özellik | Açıklama |
|---|---|
| **BPM** | Parçanın birden çok noktasından ölçüm; oktav hatalarını otomatik düzeltir |
| **½ / 2× butonları** | Tempo yanlış oktavdaysa düzelt; delay tablosu anında güncellenir |
| **Musical Key** | librosa ile gelişmiş tespit; librosa yoksa otomatik olarak JS tespite düşer. Emin değilse alternatif key'leri tıklanabilir çip olarak gösterir |
| **Camelot Wheel** | Harmonik mix için kod (ör. `A Minor = 8A`) |
| **Stüdyo Delay Tablosu** | Note / Dotted / Triplet × 1/4…1/32 nota, milisaniye cinsinden |
| **Yerel Dosya** | YouTube yerine direkt bilgisayarındaki ses/video dosyasını yükle (sürükle-bırak) |
| **MP3 İndir** | Analiz edilen parçayı `[İsim] - [BPM] BPM - [Key].mp3` formatında indir |
| **Stem Ayır (AI)** | Demucs ile: 4 stem ZIP *veya* akapella + enstrümantal ayrı MP3 |
| **Otomatik Temizlik** | MP3 dosyaları 30 dk, stem dosyaları 10 dk sonra otomatik silinir |

---

## Doğruluk

| Metrik | Başlangıç | İyileştirilmiş JS | librosa motoru |
|---|---|---|---|
| **BPM** tam isabet (±2) | %30 | **%90** | — |
| **BPM** oktav dahil | %85 | **%90.8** (n=65) | — |
| **Key** tam isabet | %28.6 | %54.2 | **%62.5** (n=24) |

> Key tespiti zordur; klasik yöntemler bas-ağırlıklı trap/drill içeriğinde %55–65 civarında tıkanır. Daha yükseği için derin öğrenme modeli gerekir.

---

## Stem Ayırma

Analiz tamamlandıktan sonra iki seçenek çıkar:

- **Extract 4 Stems (ZIP)** → Davul, bas, vokal ve diğer enstrümanları ayrı ayrı indirir
- **Acapella & Instrumental** → Sadece vokal (akapella) ve vokal-dışı (enstrümantal) indirir

> ⚠️ Stem ayırma CPU ile yapılır ve **5–15 dakika** sürebilir. Ekranda yüzde göstergesi ilerler.

---

## Sık Karşılaşılan Sorunlar

**"winget bulunamadı" hatası:**
Windows'unu güncelle (Windows 10 v1809+ veya Windows 11 gerekli)

**"Port 3000 kullanımda" hatası:**
Başka bir CALISTIR.bat penceresi açık olabilir. Görev çubuğunu kontrol et.

**Stem ayırma çok yavaş:**
Normal — GPU olmadan CPU ile çalışır, 5–15 dakika sürebilir.

**Key "low confidence" çıkıyor:**
Motor o parça için emin değil. Gösterilen alternatif key çiplerinden doğru olanı seçebilirsin.

**BPM yanlış oktav (ör. 85 yerine 170):**
Sonuç kartındaki **½** butonuna tıkla; delay tablosu da otomatik güncellenir.

**"Ses işlenirken hata" çıkıyor:**
Video bölge kısıtlamalı veya silinmiş olabilir. Farklı bir link dene.

---

*Sorun devam ederse `KURULUM.bat`'ı tekrar çalıştırmayı dene.*
