@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" -TestImage
if errorlevel 1 (
  echo.
  echo Image verification failed. See the error above.
  pause
  exit /b 1
)
echo.
pause
