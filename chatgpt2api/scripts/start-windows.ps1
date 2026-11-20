# Windows PowerShell 5.1+ / PowerShell 7; requires Docker Desktop (Linux containers).
[CmdletBinding()]
param(
    [switch]$TestImage,
    [string]$ImageModel = "gpt-image-2.6"
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$envPath = Join-Path $root ".env"
$configPath = Join-Path $root "config.json"
$dataPath = Join-Path $root "data"
$composePath = Join-Path $root "docker-compose.yml"
$port = 3000

function Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Please install and start Docker Desktop, then run this file again."
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is required." }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Start Docker Desktop first." }

New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
if (-not (Test-Path -LiteralPath $configPath)) {
    [System.IO.File]::WriteAllText($configPath, "{}" + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}
if (-not (Test-Path -LiteralPath $envPath)) {
    $random = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $secret = [BitConverter]::ToString($random).Replace("-", "").ToLowerInvariant()
    $example = [System.IO.File]::ReadAllText((Join-Path $root ".env.example"))
    $newEnv = [regex]::Replace($example, '(?m)^CHATGPT2API_AUTH_KEY=.*$', "CHATGPT2API_AUTH_KEY=$secret")
    [System.IO.File]::WriteAllText($envPath, $newEnv, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Created local .env with a random secret. It will not be printed or uploaded."
}

$settings = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"', "'") }
}
$key = [string]$settings["CHATGPT2API_AUTH_KEY"]
if ([string]::IsNullOrWhiteSpace($key) -or $key -eq "REPLACE_WITH_RANDOM_SECRET") {
    Fail "Invalid key in .env. Use scripts/setup.sh or remove the placeholder locally."
}
if ($settings.ContainsKey("CHATGPT2API_PORT") -and $settings["CHATGPT2API_PORT"] -match '^[0-9]+$') {
    $port = [int]$settings["CHATGPT2API_PORT"]
}
if ($port -lt 1 -or $port -gt 65535) { Fail "Invalid CHATGPT2API_PORT." }

Write-Host "Starting ChatGPT2API (Docker) ..."
& docker compose --project-directory $root -f $composePath up -d app
if ($LASTEXITCODE -ne 0) { Fail "Docker failed to start. Check Docker Desktop and run: docker compose logs app" }

$baseUrl = "http://127.0.0.1:$port"
$headers = @{ Authorization = "Bearer $key" }
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $models = Invoke-RestMethod -Uri "$baseUrl/v1/models" -Headers $headers -Method Get -TimeoutSec 5
        if ($null -ne $models -and $models.PSObject.Properties.Name -contains "data") { $ready = $true; break }
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $ready) {
    Fail "API did not become ready. Run docker compose -f chatgpt2api/docker-compose.yml logs app for details."
}
Write-Host "PASS: authenticated API responds at $baseUrl/v1"
try {
    Invoke-RestMethod -Uri "$baseUrl/v1/models" -Headers @{ Authorization = "Bearer deliberately-invalid-test-key" } -Method Get -TimeoutSec 5 | Out-Null
    Fail "Server accepted an invalid API key. Do not expose this service."
} catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -ne 401 -and $status -ne 403) { Fail "Authentication check failed (HTTP $status)." }
}
Write-Host "PASS: invalid API key rejected"

if ($TestImage) {
    $payload = @{ model = $ImageModel; prompt = "A small white cat on a blue background"; n = 1; response_format = "b64_json" } | ConvertTo-Json -Compress
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/v1/images/generations" -Method Post -Headers $headers -ContentType "application/json" -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 180
    } catch {
        Fail "Image generation failed. Confirm a working upstream account is configured in the local dashboard."
    }
    $encoded = [string]$response.data[0].b64_json
    if ([string]::IsNullOrWhiteSpace($encoded)) { Fail "No b64_json image returned." }
    try { $image = [Convert]::FromBase64String($encoded) } catch { Fail "Invalid image base64." }
    if ($image.Length -lt 100 -or $image.Length -gt (8 * 1024 * 1024)) { Fail "Invalid image file size." }
    $extension = ""
    if ($image[0] -eq 137 -and $image[1] -eq 80 -and $image[2] -eq 78 -and $image[3] -eq 71) { $extension = "png" }
    elseif ($image[0] -eq 255 -and $image[1] -eq 216 -and $image[2] -eq 255) { $extension = "jpg" }
    elseif ([Text.Encoding]::ASCII.GetString($image, 0, 4) -eq "RIFF" -and [Text.Encoding]::ASCII.GetString($image, 8, 4) -eq "WEBP") { $extension = "webp" }
    if (-not $extension) { Fail "Unsupported image format." }
    $output = Join-Path $dataPath ("smoke-image." + $extension)
    [System.IO.File]::WriteAllBytes($output, $image)
    Write-Host "PASS: image saved locally to $output"
} else {
    Write-Host "Image test skipped. Add your own upstream account in the dashboard, then run test-image-windows.cmd."
}

Start-Process $baseUrl
Write-Host "Dashboard opened at $baseUrl. Keep Docker Desktop running while you use the API."
Write-Host "To stop: docker compose -f chatgpt2api/docker-compose.yml down"
