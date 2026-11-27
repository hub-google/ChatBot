@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$f=Join-Path (Get-Location) '.local\admin-key.txt'; if(-not(Test-Path -LiteralPath $f)){Write-Error '請先執行 start-windows.cmd'; exit 1}; $k=[IO.File]::ReadAllText($f).Trim(); if($k -notmatch '^[a-f0-9]{64}$'){Write-Error '管理金鑰格式錯誤'; exit 1}; Set-Clipboard -Value $k; Write-Host '金鑰已複製到剪貼簿，請貼到本機管理畫面。'"
if errorlevel 1 pause
