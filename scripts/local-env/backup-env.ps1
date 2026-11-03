param(
  [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$drive = $projectRoot.Substring(0, 1).ToLower()
$unixRoot = "/mnt/$drive" + $projectRoot.Substring(2).Replace('\', '/')
$unixCache = "/opt/local-env-cache"
$winCache = Join-Path $projectRoot ".local-env-cache"

Write-Host "[1/2] Building WSL snapshot at $unixCache"
& wsl -d $Distro -u root -- bash "$unixRoot/scripts/local-env/backup-env.sh" $unixCache
if ($LASTEXITCODE -ne 0) {
  throw "WSL backup failed with exit code $LASTEXITCODE"
}

Write-Host "[2/2] Copying snapshot to $winCache"
New-Item -ItemType Directory -Force -Path $winCache | Out-Null
foreach ($name in @("manifest.json", "smart_store.sql", "mysqld.cnf", "redis.conf", "dump.rdb")) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "wsl.exe"
  $psi.Arguments = "-d $Distro -u root -- cat $unixCache/$name"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $target = Join-Path $winCache $name
  $stream = [System.IO.File]::Create($target)
  try {
    $process.StandardOutput.BaseStream.CopyTo($stream)
  } finally {
    $stream.Dispose()
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Copy $name failed with exit code $($process.ExitCode)"
  }
}

Get-ChildItem $winCache | Format-Table Name, Length