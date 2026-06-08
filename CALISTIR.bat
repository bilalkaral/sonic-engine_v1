@echo off
title BPM Analyzer - Calisiyor

cd /d "%~dp0"

node --version >nul 2>&1
if not %errorlevel% == 0 (
    echo.
    echo  Node.js bulunamadi!
    echo  Once KURULUM.bat dosyasini calistirin.
    echo.
    pause
    exit /b 1
)

if not exist "server.js" (
    echo.
    echo  server.js bulunamadi!
    echo  Bu dosya server.js ile ayni klasorde olmali.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo.
    echo  node_modules bulunamadi, npm install calistiriliyor...
    echo.
    call npm install --no-fund --no-audit
    call npm approve-scripts ffmpeg-static youtube-dl-exec 2>nul
    call npm install --no-fund --no-audit
    if not exist "node_modules" (
        echo.
        echo  HATA: npm install basarisiz oldu!
        echo  KURULUM.bat dosyasini calistirip tekrar dene.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  ============================================
echo   BPM ANALYZER BASLIYOR...
echo   Tarayici otomatik acilacak.
echo   Kapatmak icin bu pencereyi kapatin.
echo  ============================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

node server.js

echo.
echo  Sunucu kapandi.
pause
