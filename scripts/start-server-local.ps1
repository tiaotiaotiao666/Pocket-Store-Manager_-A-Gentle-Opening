$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $workspaceRoot 'server')

if (-not $env:CACHE_DRIVER) { $env:CACHE_DRIVER = 'memory' }
if (-not $env:PORT) { $env:PORT = '3000' }

Write-Host "[server:dev] workspace : $workspaceRoot"
Write-Host "[server:dev] CACHE_DRIVER=$env:CACHE_DRIVER PORT=$env:PORT"
Write-Host '[server:dev] keep memory fallback while 6379 is down; set CACHE_DRIVER=redis to test real Redis'
Write-Host '[server:dev] make sure 3306 is listening; Prisma aborts when MySQL is down'

npm run start:dev