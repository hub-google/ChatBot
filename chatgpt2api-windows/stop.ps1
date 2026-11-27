$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".local\server.pid"
if (!(Test-Path $pidFile)) { Write-Host "沒有找到已啟動服務的 PID。"; exit 0 }
$targetId = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
$target = Get-CimInstance Win32_Process -Filter "ProcessId=$targetId" -ErrorAction SilentlyContinue
$exe = [System.IO.Path]::GetFullPath((Join-Path $root "chatgpt2api.exe"))
if ($null -ne $target -and $null -ne $target.ExecutablePath -and [string]::Equals([System.IO.Path]::GetFullPath($target.ExecutablePath), $exe, [System.StringComparison]::OrdinalIgnoreCase)) {
    Stop-Process -Id $targetId -Force
    Write-Host "已停止 ChatGPT2API。"
} else {
    Write-Host "PID 已不是此專案的服務，不會停止其他程式。"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
