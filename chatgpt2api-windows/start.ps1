[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "chatgpt2api.exe"
$web = Join-Path $root "web\index.html"
if (!(Test-Path -LiteralPath $exe)) { throw "找不到 chatgpt2api.exe，請下載 Actions 建置完成的 Windows ZIP。" }
if (!(Test-Path -LiteralPath $web)) { throw "缺少 web/index.html，請完整解壓縮 ZIP。" }

$local = Join-Path $root ".local"
New-Item -ItemType Directory -Force -Path $local | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
$keyFile = Join-Path $local "admin-key.txt"
if (!(Test-Path -LiteralPath $keyFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $key = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
    [System.IO.File]::WriteAllText($keyFile, $key, (New-Object System.Text.UTF8Encoding($false)))
}
$key = [System.IO.File]::ReadAllText($keyFile).Trim()
if ($key -notmatch "^[0-9a-f]{64}$") { throw ".local/admin-key.txt 格式錯誤：必須為 64 位隨機 hex key。" }

$configFile = Join-Path $root "config.yaml"
if (!(Test-Path -LiteralPath $configFile)) {
    $example = [System.IO.File]::ReadAllText((Join-Path $root "config.example.yaml"))
    # No hardcoded default key is ever used for a normal start.
    $example = [regex]::Replace($example, "(?m)^api-key:.*$", "api-key: $key")
    [System.IO.File]::WriteAllText($configFile, $example, (New-Object System.Text.UTF8Encoding($false)))
}
$env:CHATGPT2API_AUTH_KEY = $key
$env:BIND_ADDR = "127.0.0.1"
$env:PORT = "3000"

$stdout = Join-Path $local "server.log"
$stderr = Join-Path $local "server-error.log"
Write-Host "啟動 ChatGPT2API ... 管理金鑰不會顯示在畫面上。" -ForegroundColor Cyan
$proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
[System.IO.File]::WriteAllText((Join-Path $local "server.pid"), [string]$proc.Id)

$ready = $false
for ($i = 0; $i -lt 45; $i++) {
    if ($proc.HasExited) { break }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/version" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (!$ready) {
    if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "服務未正常啟動，最近的錯誤訊息：" -ForegroundColor Red
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Tail 20 }
    throw "本機端口 3000 未能成功啟動。"
}
Write-Host "管理畫面：http://127.0.0.1:3000/" -ForegroundColor Green
Write-Host "API：http://127.0.0.1:3000/v1" -ForegroundColor Green
Write-Host "要登入，請執行 copy-admin-key.cmd 複製本機金鑰。"
Start-Process "http://127.0.0.1:3000/"
try {
    Read-Host "按 Enter 停止 ChatGPT2API"
} finally {
    if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $local "server.pid") -Force -ErrorAction SilentlyContinue
}
