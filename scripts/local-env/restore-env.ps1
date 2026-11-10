param(
  [string]$Distro = "Ubuntu-24.04",
  [switch]$WithFrontend
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$drive = $projectRoot.Substring(0, 1).ToLower()
$unixRoot = "/mnt/$drive" + $projectRoot.Substring(2).Replace('\', '/')
$unixCache = "$unixRoot/.local-env-cache"
$restoreScript = "$unixRoot/scripts/local-env/restore-env.sh"

Write-Host "[1/2] Restoring WSL environment (MySQL / Redis / Node / backend)"
& wsl -d $Distro -u root -- bash $restoreScript $unixRoot $unixCache
if ($LASTEXITCODE -ne 0) {
  throw "Restore failed with exit code $LASTEXITCODE"
}

Write-Host "[2/2] Checking backend health"
$health = (& wsl -d $Distro -u root -- curl -fsS http://127.0.0.1:3000/api/v1/health) | Out-String
$ready = (& wsl -d $Distro -u root -- curl -fsS http://127.0.0.1:3000/api/v1/readyz) | Out-String
Write-Host "health: $($health.Trim())"
Write-Host "readyz: $($ready.Trim())"

if ($WithFrontend) {
  Write-Host "Starting Vite at http://127.0.0.1:5173"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $projectRoot
} else {
  Write-Host "Start frontend manually: npm run dev (http://127.0.0.1:5173)"
}