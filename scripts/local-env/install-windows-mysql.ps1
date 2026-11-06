param(
  [string]$ServiceName = "SmartStoreMySQL"
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "[mysql] Administrator privileges required. Run this in an elevated PowerShell."
  exit 1
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$mysqlHome = Join-Path $root ".tools\mysql-8.0.28-winx64"
$dataDir = Join-Path $root ".tools\mysql-data"
$myIni = Join-Path $root ".tools\my.ini"
$mysqld = Join-Path $mysqlHome "bin\mysqld.exe"

if (-not (Test-Path $mysqld)) {
  Write-Host "[mysql] mysqld.exe not found: $mysqld"
  exit 1
}
if (-not (Test-Path $dataDir)) {
  Write-Host "[mysql] data directory not found: $dataDir"
  Write-Host "[mysql] run the initialize command first."
  exit 1
}

$basedir = $mysqlHome -replace '\\', '/'
$datadir = $dataDir -replace '\\', '/'
$ini = @"
[mysqld]
basedir=$basedir
datadir=$datadir
port=3306
bind-address=127.0.0.1
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
"@
Set-Content -Path $myIni -Value $ini -Encoding ASCII
Write-Host "[mysql] config written: $myIni"

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "[mysql] removing existing service $ServiceName"
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  & $mysqld --remove $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

Write-Host "[mysql] installing service $ServiceName"
& $mysqld --install $ServiceName --defaults-file=$myIni
Start-Sleep -Seconds 2
Start-Service $ServiceName
Start-Sleep -Seconds 6

Get-Service $ServiceName | Select-Object Name, Status | Format-Table -AutoSize
if (Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  Write-Host "[mysql] OK: 127.0.0.1:3306 is listening"
} else {
  Write-Host "[mysql] WARN: 127.0.0.1:3306 is not reachable yet; check the service log under .tools\mysql-data"
  exit 1
}