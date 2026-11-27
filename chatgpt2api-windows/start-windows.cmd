@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (
  echo.
  echo 啟動失敗。請閱讀上方錯誤，按任意鍵關閉。
  pause >nul
)
