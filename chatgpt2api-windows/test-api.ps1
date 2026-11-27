[CmdletBinding()]
param([ValidateSet("auth","text","image")][string]$Mode="auth")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$keyPath = Join-Path $root ".local\admin-key.txt"
if (!(Test-Path -LiteralPath $keyPath)) { throw "找不到管理金鑰，請先執行 start-windows.cmd。" }
$key = [System.IO.File]::ReadAllText($keyPath).Trim()
if ($key -notmatch "^[0-9a-f]{64}$") { throw "金鑰格式錯誤" }
$base = "http://127.0.0.1:3000"
$h = @{ Authorization = "Bearer $key"; Accept="application/json" }

try {
  $models = Invoke-RestMethod -Method Get -Uri "$base/v1/models" -Headers $h -TimeoutSec 20
  if ($null -eq $models.data) { throw "/v1/models 回傳格式錯誤" }
  Write-Host "PASS: 正確金鑰已獲得 /v1/models 回應" -ForegroundColor Green
} catch {
  Write-Host "FAIL: 本機服務未啟動或 API 金鑰無效: $($_.Exception.Message)" -ForegroundColor Red
  exit 2
}

$invalidRejected = $false
try {
  Invoke-WebRequest -Method Get -Uri "$base/v1/models" -Headers @{Authorization="Bearer intentionally-invalid-test-key"} -UseBasicParsing -TimeoutSec 10 | Out-Null
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -in @(401,403)) { $invalidRejected = $true }
}
if (!$invalidRejected) { Write-Host "FAIL: 無效金鑰沒有被拒絕" -ForegroundColor Red; exit 3 }
Write-Host "PASS: 無效金鑰被拒絕（401/403）" -ForegroundColor Green
if ($Mode -eq "auth") { Write-Host "PASS: 本機 API 驗收完成（尚未驗證真正生成）"; exit 0 }

if ($Mode -eq "text") {
  $payload = @{model="auto"; messages=@(@{role="user";content="請只回答：測試成功"});stream=$false} | ConvertTo-Json -Depth 8 -Compress
  try {
    $res = Invoke-RestMethod -Method Post -Uri "$base/v1/chat/completions" -Headers $h -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 180
    $answer = $res.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace([string]$answer)) { throw "文字回應為空" }
    Write-Host ("PASS: 上游真實文字生成：" + $answer) -ForegroundColor Green
    exit 0
  } catch { Write-Host ("FAIL: 真實文字生成失敗：" + $_.Exception.Message) -ForegroundColor Red; exit 4 }
}
if ($Mode -eq "image") {
  $payload = @{model="gpt-image-2.6";prompt="一隻站在白底前的橘貓";n=1;response_format="b64_json"} | ConvertTo-Json -Depth 8 -Compress
  try {
    $res = Invoke-RestMethod -Method Post -Uri "$base/v1/images/generations" -Headers $h -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 360
    $encoded = $res.data[0].b64_json
    if ([string]::IsNullOrWhiteSpace($encoded)) { throw "圖片回應缺少 b64_json" }
    $bytes = [Convert]::FromBase64String($encoded)
    if ($bytes.Length -lt 100) { throw "圖片大小異常" }
    $out = Join-Path $root "test-generated-image.png"
    [IO.File]::WriteAllBytes($out, $bytes)
    Write-Host ("PASS: 上游真實圖片生成：" + $out) -ForegroundColor Green
    exit 0
  } catch { Write-Host ("FAIL: 真實圖片生成失敗：" + $_.Exception.Message) -ForegroundColor Red; exit 5 }
}
