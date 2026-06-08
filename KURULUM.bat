@echo off
title BPM Analyzer - Kurulum
chcp 65001 >nul

echo.
echo  ============================================
echo   BPM ANALYZER - OTOMATIK KURULUM
echo   Internet gerekli. 10-20 dk surebilir.
echo  ============================================
echo.

cd /d "%~dp0"

:: ─── Winget var mi? ────────────────────────────────────────────────────────
winget --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  HATA: winget bulunamadi!
    echo  Windows 10 v1809 veya uzeri gereklidir.
    echo  Windows Update ile guncelleme yapip tekrar calistir.
    echo.
    pause
    exit /b 1
)

:: ─── PATH'i registry'den yenile (winget kurulumundan sonra cagirilir) ──────
:refreshpath
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')"`) do set "PATH=%%i"
goto :eof

:: ─── 1. Node.js ────────────────────────────────────────────────────────────
echo [1/8] Node.js kontrol ediliyor...
node --version >nul 2>&1
if errorlevel 1 (
    echo        Bulunamadi, kuruluyor...
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    call :refreshpath
    node --version >nul 2>&1
    if errorlevel 1 set "PATH=%PATH%;C:\Program Files\nodejs"
    echo        Node.js kuruldu.
) else (
    for /f %%v in ('node --version') do echo        Mevcut: %%v
)

:: ─── 2. Python ─────────────────────────────────────────────────────────────
echo.
echo [2/8] Python kontrol ediliyor...
python --version >nul 2>&1
if errorlevel 1 (
    echo        Bulunamadi, kuruluyor...
    winget install Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
    call :refreshpath
    python --version >nul 2>&1
    if errorlevel 1 (
        set "PATH=%PATH%;C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311"
        set "PATH=%PATH%;C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python311\Scripts"
    )
    echo        Python kuruldu.
) else (
    for /f %%v in ('python --version') do echo        Mevcut: %%v
)

:: ─── 3. FFmpeg ─────────────────────────────────────────────────────────────
echo.
echo [3/8] FFmpeg kontrol ediliyor...
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo        Bulunamadi, kuruluyor...
    winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
    call :refreshpath
    echo        FFmpeg kuruldu.
) else (
    echo        Mevcut.
)

:: ─── 4. Node paketleri ─────────────────────────────────────────────────────
echo.
echo [4/8] Node paketleri yukleniyor...
if not exist "package.json" (
    echo HATA: package.json bulunamadi! Bu dosya server.js ile ayni klasorde olmali.
    pause
    exit /b 1
)
call npm install --no-fund --no-audit
call npm approve-scripts ffmpeg-static youtube-dl-exec 2>nul
call npm install --no-fund --no-audit
echo        Node paketleri yuklendi.

:: ─── 5. NumPy ──────────────────────────────────────────────────────────────
echo.
echo [5/8] NumPy kuruluyor...
python -m pip install "numpy<2" --no-warn-script-location --progress-bar on
echo        NumPy kuruldu.

:: ─── 6. PyTorch + torchaudio (CPU) ────────────────────────────────────────
echo.
echo [6/8] PyTorch kuruluyor... (buyuk paket, bekle)
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu --no-warn-script-location --progress-bar on
echo        PyTorch kuruldu.

:: ─── 7. Demucs + yt-dlp ───────────────────────────────────────────────────
echo.
echo [7/8] Demucs ve yt-dlp kuruluyor...
python -m pip install demucs==4.0.1 --no-warn-script-location --progress-bar on
python -m pip install yt-dlp --upgrade --no-warn-script-location --progress-bar on
echo        Demucs ve yt-dlp kuruldu.

:: ─── 8. librosa ───────────────────────────────────────────────────────────
echo.
echo [8/8] librosa kuruluyor...
python -m pip install librosa soundfile --no-warn-script-location --progress-bar on
echo        librosa kuruldu.

echo.
echo  ============================================
echo   KURULUM TAMAMLANDI!
echo   CALISTIR.bat ile uygulamayi acabilirsin.
echo  ============================================
echo.
pause
