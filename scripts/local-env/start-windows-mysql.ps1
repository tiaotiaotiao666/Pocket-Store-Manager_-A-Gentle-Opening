param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$myIni = Join-Path $root ".tools\my.ini"
$mysqld = Join-Path $root ".tools\mysql-8.0.28-winx64\bin\mysqld.exe"

if (-not (Test-Path $mysqld)) {
  Write-Host "[mysql] mysqld.exe not found: $mysqld"
  exit 1
}
if (-not (Test-Path $myIni)) {
  Write-Host "[mysql] config not found: $myIni"
  Write-Host "[mysql] run install-windows-mysql.ps1 once as administrator."
  exit 1
}

Write-Host "[mysql] starting in foreground (Ctrl+C to stop)"
& $mysqld --defaults-file=$myIni --console