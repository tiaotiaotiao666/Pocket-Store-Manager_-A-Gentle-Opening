#!/bin/bash
set -euo pipefail

PROJECT_DIR="${1:?usage: restore-env.sh <project-dir> <cache-dir>}"
CACHE_DIR="${2:?usage: restore-env.sh <project-dir> <cache-dir>}"
APP_DIR="${SMART_STORE_APP_DIR:-/opt/smart-store-server}"
DEFAULT_NODE_VERSION="22.23.4"

node_version() {
  if [ -f "$CACHE_DIR/manifest.json" ]; then
    sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' "$CACHE_DIR/manifest.json" | head -1
  fi
}

ensure_packages() {
  for cmd in mysqld redis-server mysql redis-cli; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "[restore] 安装 mysql-server 与 redis-server"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y mysql-server redis-server
      return 0
    fi
  done
  echo "[restore] MySQL/Redis 已安装"
}

ensure_node() {
  if [ -x /opt/node22/bin/node ]; then
    echo "[restore] Node 已存在: $(/opt/node22/bin/node -v)"
    return 0
  fi
  local version
  version="$(node_version)"
  version="${version:-$DEFAULT_NODE_VERSION}"
  echo "[restore] 安装 Node v$version"
  if ! curl -fsSL --max-time 300 -o /tmp/node.tar.xz "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz"; then
    echo "[restore] 固定版本下载失败，改用 latest-v22.x"
    curl -fsSL --max-time 300 -o /tmp/node.tar.xz "https://nodejs.org/dist/latest-v22.x/node-v$version-linux-x64.tar.xz"
  fi
  mkdir -p /opt/node22
  tar -xJf /tmp/node.tar.xz -C /opt/node22 --strip-components=1
  rm -f /tmp/node.tar.xz
  ln -sf /opt/node22/bin/node /usr/local/bin/node
  ln -sf /opt/node22/bin/npm /usr/local/bin/npm
  ln -sf /opt/node22/bin/npx /usr/local/bin/npx
}

ensure_app() {
  if [ -d "$APP_DIR/node_modules" ] && [ -f "$APP_DIR/package.json" ]; then
    echo "[restore] 后端目录已存在: $APP_DIR"
    return 0
  fi
  echo "[restore] 从 $PROJECT_DIR/server 重建 $APP_DIR"
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  tar -C "$PROJECT_DIR/server" --exclude=node_modules --exclude=dist -cf - . | tar -C "$APP_DIR" -xf -
  cd "$APP_DIR"
  npm ci --offline --no-audit --no-fund || npm install --no-audit --no-fund
  npm run build
}

ensure_redis_config() {
  if ! grep -q '^requirepass' /etc/redis/redis.conf; then
    echo 'requirepass smart_store_dev' >> /etc/redis/redis.conf
  fi
  sed -i 's/^bind 127.0.0.1 -::1/bind 0.0.0.0/' /etc/redis/redis.conf
}

ensure_database() {
  mkdir -p /var/run/mysqld
  chown mysql:mysql /var/run/mysqld
  if ! pgrep -x mysqld >/dev/null 2>&1; then
    mysqld --user=mysql --daemonize
  fi
  for _ in $(seq 1 30); do
    if mysqladmin -uroot ping >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  mysql -uroot -e "CREATE DATABASE IF NOT EXISTS smart_store CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE IF NOT EXISTS smart_store_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'smart_store'@'%' IDENTIFIED BY 'smart_store_dev'; ALTER USER 'smart_store'@'%' IDENTIFIED BY 'smart_store_dev'; GRANT ALL PRIVILEGES ON smart_store.* TO 'smart_store'@'%'; GRANT ALL PRIVILEGES ON smart_store_test.* TO 'smart_store'@'%'; FLUSH PRIVILEGES;"

  local tables
  tables="$(mysql -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='smart_store'")"
  if [ "$tables" != "0" ]; then
    echo "[restore] 数据库已有 $tables 张表，跳过初始化"
    return 0
  fi
  if [ -f "$CACHE_DIR/smart_store.sql" ]; then
    echo "[restore] 从快照导入数据库"
    mysql -uroot < "$CACHE_DIR/smart_store.sql"
  else
    echo "[restore] 执行 Prisma 迁移与种子"
    cd "$APP_DIR"
    npx prisma migrate deploy
    npm run db:seed
  fi
}

ensure_service() {
  if [ ! -d /run/systemd/system ]; then
    echo "[restore] systemd 不可用，跳过服务安装"
    return 0
  fi
  if systemctl cat smart-store-server >/dev/null 2>&1; then
    echo "[restore] systemd 服务已存在"
  else
    echo "[restore] 安装 systemd 服务 smart-store-server"
    cat > /etc/systemd/system/smart-store-server.service <<'EOF'
[Unit]
Description=Smart Store NestJS backend
After=network.target mysql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/smart-store-server
ExecStart=/opt/node22/bin/node dist/main.js
Restart=on-failure
RestartSec=3
EnvironmentFile=/opt/smart-store-server/.env

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
  fi
  systemctl enable smart-store-server >/dev/null 2>&1 || true
}

ensure_redis_config
ensure_packages
ensure_node
ensure_app
ensure_database
ensure_service

bash "$(dirname "$0")/start-wsl-services.sh"
echo "[restore] 完成"