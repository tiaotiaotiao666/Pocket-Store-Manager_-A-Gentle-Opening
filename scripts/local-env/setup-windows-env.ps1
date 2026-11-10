param(
  [string]$MysqlVersion = "8.0.28",
  [string]$ServiceName = "SmartStoreMySQL",
  [string]$DbName = "smart_store",
  [string]$TestDbName = "smart_store_test",
  [string]$DbUser = "smart_store",
  [string]$DbPassword = "smart_store_dev",
  [switch]$SkipSeed
)

# 一键初始化 Windows 本机开发环境：
# 下载 MySQL → 解压 → 初始化数据目录 → 注册 Windows 服务 → 建库/账号
# → 生成 server/.env → 安装依赖 → Prisma 迁移/种子。
# 之后由用户执行 `npm run server:dev` 启动后端。

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolsDir = Join-Path $root ".tools"
$zipPath = Join-Path $toolsDir ("mysql-" + $MysqlVersion + "-winx64.zip")
$mysqlHome = Join-Path $toolsDir ("mysql-" + $MysqlVersion + "-winx64")
$dataDir = Join-Path $toolsDir "mysql-data"
$mysqld = Join-Path $mysqlHome "bin\mysqld.exe"
$mysqlExe = Join-Path $mysqlHome "bin\mysql.exe"

function Write-Step([string]$message) {
  Write-Host ("[setup] " + $message)
}

# ---------- 1. 管理员 ----------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Step "需要管理员权限（注册 MySQL 服务）。请以管理员身份打开 PowerShell 后重试。"
  exit 1
}

# ---------- 2. Node.js ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Step "未找到 Node.js。请先安装 Node.js 20 或 22（https://nodejs.org/）。"
  exit 1
}
$nodeVersion = (& node -v).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 20) {
  Write-Step ("Node 版本过低：{0}，需要 20 或以上。" -f $nodeVersion)
  exit 1
}
Write-Step ("Node {0}" -f $nodeVersion)

# ---------- 3. 端口冲突 ----------
$listeners = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Step "3306 已被其他进程占用，且不是 $ServiceName。请先停止占用进程或修改 MySQL 端口。"
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

# ---------- 4. 下载 MySQL ----------
if (-not (Test-Path $zipPath)) {
  $url = "https://mirrors.aliyun.com/mysql/MySQL-8.0/mysql-$MysqlVersion-winx64.zip"
  Write-Step ("下载 MySQL {0}（约 212 MB）：{1}" -f $MysqlVersion, $url)
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 2 -o $zipPath $url
    if ($LASTEXITCODE -ne 0) {
      Write-Step "下载失败。请检查网络，或手动下载后放到 $zipPath"
      exit 1
    }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $zipPath
  }
} else {
  Write-Step ("已存在压缩包，跳过下载：{0}" -f $zipPath)
}

# ---------- 5. 解压 ----------
if (-not (Test-Path $mysqld)) {
  Write-Step "解压 MySQL"
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path $tar) {
    & $tar -xf $zipPath -C $toolsDir
  } else {
    Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
  }
  if (-not (Test-Path $mysqld)) {
    Write-Step "解压后仍未找到 mysqld.exe，请检查压缩包。"
    exit 1
  }
}

# ---------- 6. 初始化数据目录 ----------
if (-not (Test-Path (Join-Path $dataDir "ibdata1"))) {
  Write-Step "初始化 MySQL 数据目录"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $basedir = $mysqlHome -replace '\\', '/'
  $datadir = $dataDir -replace '\\', '/'
  & $mysqld --initialize-insecure "--basedir=$basedir" "--datadir=$datadir"
} else {
  Write-Step "数据目录已初始化，跳过"
}

# ---------- 7. 注册并启动服务 ----------
$installScript = Join-Path $PSScriptRoot "install-windows-mysql.ps1"
if (-not (Test-Path $installScript)) {
  Write-Step "缺少 install-windows-mysql.ps1，无法注册服务。"
  exit 1
}
& powershell -NoProfile -ExecutionPolicy Bypass -File $installScript -ServiceName $ServiceName
if ($LASTEXITCODE -ne 0) {
  Write-Step "MySQL 服务安装失败。"
  exit 1
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Test-NetConnection -ComputerName 127.0.0.1 -Port 3306 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  Write-Step "等待 3306 超时，请检查服务日志：$dataDir"
  exit 1
}

# ---------- 8. 建库与账号 ----------
Write-Step "创建数据库与账号"
& $mysqlExe -uroot -h127.0.0.1 -e "CREATE DATABASE IF NOT EXISTS $DbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
& $mysqlExe -uroot -h127.0.0.1 -e "CREATE DATABASE IF NOT EXISTS $TestDbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
& $mysqlExe -uroot -h127.0.0.1 -e "CREATE USER IF NOT EXISTS '$DbUser'@'%' IDENTIFIED BY '$DbPassword'"
& $mysqlExe -uroot -h127.0.0.1 -e "ALTER USER '$DbUser'@'%' IDENTIFIED BY '$DbPassword'"
& $mysqlExe -uroot -h127.0.0.1 -e "GRANT ALL PRIVILEGES ON $DbName.* TO '$DbUser'@'%'"
& $mysqlExe -uroot -h127.0.0.1 -e "GRANT ALL PRIVILEGES ON $TestDbName.* TO '$DbUser'@'%'"
& $mysqlExe -uroot -h127.0.0.1 -e "FLUSH PRIVILEGES"

# ---------- 9. 生成/更新 server/.env ----------
$envPath = Join-Path $root "server\.env"
$examplePath = Join-Path $root "server\.env.example"
if (-not (Test-Path $envPath)) {
  if (-not (Test-Path $examplePath)) {
    Write-Step "缺少 server/.env.example，无法生成 .env"
    exit 1
  }
  Copy-Item $examplePath $envPath
  Write-Step "已从 .env.example 生成 server/.env"
}

$dbUrl = "mysql://{0}:{1}@127.0.0.1:3306/{2}" -f $DbUser, $DbPassword, $DbName
$testDbUrl = "mysql://{0}:{1}@127.0.0.1:3306/{2}" -f $DbUser, $DbPassword, $TestDbName

function Set-EnvLine([string]$text, [string]$key, [string]$value) {
  $pattern = "(?m)^" + [regex]::Escape($key) + "=.*$"
  $line = $key + "=" + $value
  if ([regex]::IsMatch($text, $pattern)) {
    return [regex]::Replace($text, $pattern, $line)
  }
  return ($text.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine)
}

$content = Get-Content $envPath -Raw
$content = Set-EnvLine $content "DATABASE_URL" ('"' + $dbUrl + '"')
$content = Set-EnvLine $content "TEST_DATABASE_URL" ('"' + $testDbUrl + '"')
$content = Set-EnvLine $content "CACHE_DRIVER" "memory"
Set-Content -Path $envPath -Value $content -Encoding UTF8
Write-Step "server/.env 已指向本机 MySQL（$DbUser@127.0.0.1:3306）"

# ---------- 10. 依赖、迁移、种子 ----------
Write-Step "安装根目录依赖"
Push-Location $root
try {
  & npm install --no-audit --no-fund
} finally {
  Pop-Location
}

Push-Location (Join-Path $root "server")
try {
  Write-Step "安装后端依赖"
  & npm install --no-audit --no-fund
  Write-Step "生成 Prisma Client"
  & npx prisma generate
  Write-Step "执行数据库迁移"
  & npx prisma migrate deploy
  if (-not $SkipSeed) {
    Write-Step "写入种子数据"
    & npm run db:seed
  }
} finally {
  Pop-Location
}

Write-Step "环境初始化完成。"
Write-Step "启动后端：npm run server:dev"
Write-Step "微信开发者工具：设置→代理设置→不使用代理；详情→本地设置→勾选不校验合法域名。"