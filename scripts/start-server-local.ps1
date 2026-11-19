$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $workspaceRoot 'server')

if (-not $env:CACHE_DRIVER) { $env:CACHE_DRIVER = 'memory' }
if (-not $env:PORT) { $env:PORT = '3000' }
# B2：本机一键启动默认只监听回环 + 强制鉴权。
# 桌面端会自动向 /api/v1/desktop/session 申领短期会话，
# 所以这里开启鉴权不需要用户手工填任何 Authorization。
if (-not $env:SERVER_HOST) { $env:SERVER_HOST = '127.0.0.1' }
if (-not $env:AGENT_REQUIRE_AUTH) { $env:AGENT_REQUIRE_AUTH = 'true' }

Write-Host "[server:dev] workspace : $workspaceRoot"
Write-Host "[server:dev] CACHE_DRIVER=$env:CACHE_DRIVER PORT=$env:PORT"
Write-Host "[server:dev] SERVER_HOST=$env:SERVER_HOST AGENT_REQUIRE_AUTH=$env:AGENT_REQUIRE_AUTH (桌面端自动申领会话，无需手工填 Token)"
Write-Host '[server:dev] LAN access requires SERVER_HOST=<nic ip> + AGENT_REQUIRE_AUTH=true (forced by env validation)'
Write-Host '[server:dev] keep memory fallback while 6379 is down; set CACHE_DRIVER=redis to test real Redis'
Write-Host '[server:dev] make sure 3306 is listening; Prisma aborts when MySQL is down'

npm run start:dev