#!/bin/bash
set -euo pipefail

CACHE_DIR="${1:-/opt/local-env-cache}"
mkdir -p "$CACHE_DIR"

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mysqldump -uroot --databases smart_store > "$CACHE_DIR/smart_store.sql.tmp"
mv "$CACHE_DIR/smart_store.sql.tmp" "$CACHE_DIR/smart_store.sql"

redis-cli -a smart_store_dev --no-auth-warning --rdb "$CACHE_DIR/dump.rdb.tmp" >/dev/null
mv "$CACHE_DIR/dump.rdb.tmp" "$CACHE_DIR/dump.rdb"

cp /etc/mysql/mysql.conf.d/mysqld.cnf "$CACHE_DIR/mysqld.cnf"
cp /etc/redis/redis.conf "$CACHE_DIR/redis.conf"

cat > "$CACHE_DIR/manifest.json.tmp" <<EOF
{
  "createdAt": "$STAMP",
  "wslDistro": "Ubuntu-24.04",
  "node": "$(/opt/node22/bin/node -v 2>/dev/null || echo unknown)",
  "appDir": "/opt/smart-store-server",
  "npmCache": "/root/.npm",
  "database": "smart_store",
  "redisPassword": "smart_store_dev"
}
EOF
mv "$CACHE_DIR/manifest.json.tmp" "$CACHE_DIR/manifest.json"

echo "[backup] done: $CACHE_DIR"
ls -lh "$CACHE_DIR"