# smart-store-generator one-click launcher
# ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8 without BOM.
#
# Usage (from the workspace root):
#   npm start                 # MySQL -> backend -> desktop
#   npm run start:all
#   npm run start:all -- -ServerOnly
#   npm run start:all -- -SkipMysql
#   npm run start:all -- -RestartBackend
#   npm stop                  # stop backend + MySQL
#
# Notes:
# - MySQL is the portable ZIP build at E:\smartstore-tools (ASCII path only).
# - CACHE_DRIVER defaults to memory when 6379 is not reachable, because
#   server/.env ships with CACHE_DRIVER=redis and Nest aborts on connect failure.
# - ELECTRON_RUN_AS_NODE is cleared before launching Electron.

param(
  [switch]$Stop,
  [switch]$ServerOnly,
  [switch]$SkipMysql,
  [switch]$RestartBackend,
  [int]$MysqlTimeoutSeconds = 90,
  [int]$BackendTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $workspaceRoot '.npm-logs\start-all'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$mysqlHome = 'E:\smartstore-tools\mysql'
$mysqlData = 'E:\smartstore-tools\mysql-data'
$mysqldPath = Join-Path $mysqlHome 'bin\mysqld.exe'
$mysqlAdminPath = Join-Path $mysqlHome 'bin\mysqladmin.exe'

$serverScript = Join-Path $workspaceRoot 'scripts\start-server-local.ps1'
$healthUrl = 'http://127.0.0.1:3000/api/v1/health'

function Write-Step {
  param([string]$Text)
  Write-Host ''
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Text)
  Write-Host "    [OK] $Text" -ForegroundColor Green
}

function Write-Info {
  param([string]$Text)
  Write-Host "    [..] $Text" -ForegroundColor Gray
}

function Write-Warn {
  param([string]$Text)
  Write-Host "    [WARN] $Text" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Text)
  Write-Host "    [FAIL] $Text" -ForegroundColor Red
}

function Test-TcpPort {
  param(
    [string]$TargetHost = '127.0.0.1',
    [int]$Port,
    [int]$TimeoutMs = 800
  )
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    if ($client -ne $null) { $client.Close() }
  }
}

function Test-MysqlAlive {
  if (-not (Test-TcpPort -TargetHost '127.0.0.1' -Port 3306)) { return $false }
  if (-not (Test-Path $mysqlAdminPath)) { return $true }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $output = & $mysqlAdminPath '--host=127.0.0.1' '--port=3306' '--user=root' 'ping' 2>&1
    if (($output | Out-String) -match 'alive') { return $true }
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Wait-MysqlAlive {
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-MysqlAlive) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Test-BackendHealth {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Wait-BackendHealth {
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BackendHealth) { return $true }
    Start-Sleep -Milliseconds 1500
  }
  return $false
}

function Show-LogTail {
  param([string]$Path, [int]$LineCount = 25)
  if (Test-Path $Path) {
    Write-Host "    --- tail: $Path ---" -ForegroundColor Dark Gray
    Get-Content -Path $Path -Tail $LineCount -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "    $_" -ForegroundColor Dark Gray }
  }
}

function Stop-Listener {
  param([int]$Port)
  $owners = @()
  try {
    $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $owners = @()
  }
  foreach ($ownerProcessId in $owners) {
    Stop-Process -Id $ownerProcessId -Force -ErrorAction SilentlyContinue
  }
  return ($owners.Count -gt 0)
}

Write-Host ''
Write-Host 'smart-store-generator :: one-click launcher' -ForegroundColor Magenta
Write-Host "workspace : $workspaceRoot"

if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

if ($Stop) {
  Write-Step 'Stopping local services'
  if (Test-TcpPort -TargetHost '127.0.0.1' -Port 3000) {
    if (Stop-Listener -Port 3000) { Write-Ok 'backend on port 3000 stopped' }
  } else {
    Write-Info 'backend is not running'
  }
  if (Test-TcpPort -TargetHost '127.0.0.1' -Port 3306) {
    $shutdownOk = $false
    if (Test-Path $mysqlAdminPath) {
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = 'SilentlyContinue'
      try {
        & $mysqlAdminPath '--host=127.0.0.1' '--port=3306' '--user=root' 'shutdown' 2>&1 | Out-Null
      } finally {
        $ErrorActionPreference = $previousPreference
      }
      Start-Sleep -Seconds 2
      $shutdownOk = -not (Test-TcpPort -TargetHost '127.0.0.1' -Port 3306)
    }
    if (-not $shutdownOk) { Stop-Listener -Port 3306 | Out-Null }
    Write-Ok 'mysql on port 3306 stopped'
  } else {
    Write-Info 'mysql is not running'
  }
  Write-Info 'close the Electron window manually if it is still open.'
  exit 0
}

Write-Step '[1/3] MySQL (127.0.0.1:3306)'
if ($SkipMysql) {
  Write-Info 'skipped (-SkipMysql)'
} elseif (Test-MysqlAlive) {
  Write-Ok 'already running'
} else {
  if (-not (Test-Path $mysqldPath)) {
    Write-Fail "mysqld not found: $mysqldPath"
    Write-Info 'install the portable MySQL 8.4 ZIP into E:\smartstore-tools\mysql'
    exit 1
  }
  $mysqlOut = Join-Path $logDir "mysql-$stamp.out.log"
  $mysqlErr = Join-Path $logDir "mysql-$stamp.err.log"
  Start-Process -FilePath $mysqldPath -ArgumentList @(
    "--basedir=$mysqlHome",
    "--datadir=$mysqlData",
    '--port=3306'
  ) -RedirectStandardOutput $mysqlOut -RedirectStandardError $mysqlErr -WindowStyle Hidden
  Write-Info "starting mysqld, log: $mysqlOut"
  if (-not (Wait-MysqlAlive -TimeoutSeconds $MysqlTimeoutSeconds)) {
    Write-Fail "mysql did not become ready within $MysqlTimeoutSeconds s"
    Show-LogTail -Path $mysqlErr
    Show-LogTail -Path $mysqlOut
    exit 1
  }
  Write-Ok 'mysql ready'
}

Write-Step '[2/3] backend (127.0.0.1:3000)'
$backendReady = $false
if ($RestartBackend) {
  if (Test-TcpPort -TargetHost '127.0.0.1' -Port 3000) {
    Stop-Listener -Port 3000 | Out-Null
    Start-Sleep -Seconds 1
    Write-Info 'old listener on port 3000 stopped (-RestartBackend)'
  }
}

if (Test-BackendHealth) {
  Write-Ok 'backend already healthy'
  $backendReady = $true
} elseif (Test-TcpPort -TargetHost '127.0.0.1' -Port 3000) {
  Write-Info 'port 3000 is listening, waiting for /api/v1/health ...'
  if (Wait-BackendHealth -TimeoutSeconds 45) {
    Write-Ok 'backend healthy'
    $backendReady = $true
  } else {
    Write-Fail 'port 3000 is occupied but health check keeps failing'
    Write-Info 'rerun with -RestartBackend to replace the old process'
    exit 1
  }
}

if (-not $backendReady) {
  if (-not (Test-Path $serverScript)) {
    Write-Fail "server launcher not found: $serverScript"
    exit 1
  }
  if (-not (Test-Path (Join-Path $workspaceRoot 'server\node_modules'))) {
    Write-Fail 'server dependencies are missing'
    Write-Info 'run: cd server; npm install'
    exit 1
  }
  if (-not $env:CACHE_DRIVER) { $env:CACHE_DRIVER = 'memory' }
  if (-not $env:PORT) { $env:PORT = '3000' }
  $serverOut = Join-Path $logDir "server-$stamp.out.log"
  $serverErr = Join-Path $logDir "server-$stamp.err.log"
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts\start-server-local.ps1'
  ) -WorkingDirectory $workspaceRoot -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
  Write-Info "CACHE_DRIVER=$env:CACHE_DRIVER PORT=$env:PORT"
  Write-Info "starting backend, log: $serverOut"
  if (-not (Wait-BackendHealth -TimeoutSeconds $BackendTimeoutSeconds)) {
    Write-Fail "backend did not become healthy within $BackendTimeoutSeconds s"
    Show-LogTail -Path $serverOut
    Show-LogTail -Path $serverErr
    Write-Info 'common cause: MySQL is down, or CACHE_DRIVER=redis while 6379 is unreachable'
    exit 1
  }
  Write-Ok 'backend ready'
}

try {
  $ready = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/v1/readyz' -UseBasicParsing -TimeoutSec 3
  Write-Info "readyz HTTP $($ready.StatusCode)"
} catch {
  Write-Warn 'readyz did not respond (backend may still be warming up)'
}

if ($ServerOnly) {
  Write-Step '[3/3] desktop skipped (-ServerOnly)'
  Write-Host ''
  Write-Host 'Backend is running in the background. Stop it with: npm stop' -ForegroundColor Green
  exit 0
}

Write-Step '[3/3] desktop (Vite 127.0.0.1:5173 + Electron)'
if (Test-TcpPort -TargetHost '127.0.0.1' -Port 5173) {
  Write-Fail 'port 5173 is already in use: another desktop dev instance is running.'
  Write-Info 'Electron always loads http://127.0.0.1:5173, so launching again would attach to the OLD Vite server (stale code).'
  Write-Info 'close the existing Electron window first (its concurrently watcher releases 5173), then rerun: npm start'
  Write-Info 'if only the backend was needed, use: npm run start:all -- -ServerOnly'
  exit 1
}
if ($env:ELECTRON_RUN_AS_NODE) {
  Write-Info 'clearing ELECTRON_RUN_AS_NODE for this session'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'launching Electron; close the window or press Ctrl+C to exit the launcher.' -ForegroundColor Cyan
Write-Host ''
Set-Location $workspaceRoot
& npm run desktop:dev
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }

Write-Host ''
Write-Info "desktop:dev exited with code $exitCode"
Write-Info 'backend and mysql keep running in the background. Stop them with: npm stop'
exit $exitCode