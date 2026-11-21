@echo off
rem Starts CosyVoice in WSL and the reader in Windows, each in its own window, then opens the browser.
cd /d "%~dp0"

start "CosyVoice" wsl.exe --cd "%~dp0cosyvoice" -- bash -lc "source ~/miniconda3/etc/profile.d/conda.sh && conda activate cosyvoice && python server.py --port 50000 --model_dir iic/CosyVoice2-0.5B; echo; echo CosyVoice stopped. Press Enter to close.; read"

if not exist node_modules (
  call npm.cmd install --registry=https://registry.npmmirror.com
)
start "Hiyori Reader" cmd /k npm.cmd run dev

timeout /t 8 /nobreak >nul
start "" http://localhost:5173
