@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
if errorlevel 1 (
  echo.
  echo ChatGPT2API failed to start. Check the error above.
  pause
  exit /b 1
)
echo.
pause
