@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-api.ps1" -Mode auth
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-api.ps1" -Mode "%~1"
)
if errorlevel 1 (echo 測試失敗 & pause)
