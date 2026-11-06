#!/bin/bash
set -euo pipefail

APP_DIR="${SMART_STORE_APP_DIR:-/opt/smart-store-server}"
LOG_FILE="/tmp/smart-store-server.log"
NO_BACKEND=0

if [ "${1:-}" = "--no-backend" ]; then
  NO_BACKEND=1
fi

systemd_available() {
  [ -d /run/systemd/system ]
}

fallback_mysql() {
  if pgrep -x mysqld >/dev/null 2>&1; then
    echo "[mysql] already running"
    return 0
  fi
  mkdir -p /var/run/mysqld
  chown mysql:mysql /var/run/mysqld
  mysqld --user=mysql --daemonize
  echo "[mysql] started"
}

fallback_redis() {
  if pgrep -x redis-server >/dev/null 2>&1; then
    echo "[redis] already running"
    return 0
  fi
  redis-server /etc/redis/redis.conf --daemonize yes
  echo "[redis] started"
}

start_services() {
  if systemd_available; then
    systemctl start mysql redis-server
    echo "[mysql] $(systemctl is-active mysql)"
    echo "[redis] $(systemctl is-active redis-server)"
    return 0
  fi
  fallback_mysql
  fallback_redis
}

start_backend() {
  if systemd_available && systemctl cat smart-store-server >/dev/null 2>&1; then
    systemctl start smart-store-server
    echo "[backend] $(systemctl is-active smart-store-server) (systemd)"
    return 0
  fi
  if pgrep -f "node dist/main.js" >/dev/null 2>&1; then
    echo "[backend] already running"
    return 0
  fi
  if [ ! -f "$APP_DIR/dist/main.js" ]; then
    echo "[backend] dist/main.js missing, building..."
    cd "$APP_DIR"
    npm run build >/dev/null
  fi
  cd "$APP_DIR"
  nohup node dist/main.js > "$LOG_FILE" 2>&1 &
  echo "[backend] started, log: $LOG_FILE"
}

wait_for_http() {
  local url="http://127.0.0.1:3000/api/v1/$1"
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      curl -sS "$url"
      echo
      return 0
    fi
    sleep 1
  done
  echo "[backend] health check failed: $url" >&2
  if systemd_available; then
    journalctl -u smart-store-server -n 20 --no-pager >&2 || true
  else
    tail -20 "$LOG_FILE" >&2 || true
  fi
  return 1
}

start_services
if [ "$NO_BACKEND" = "0" ]; then
  start_backend
  wait_for_http health
else
  echo "[backend] skipped (--no-backend)"
fi