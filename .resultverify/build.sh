#!/usr/bin/env bash
set -u -o pipefail

VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$VERIFY_DIR/.." && pwd)"
STARTED_AT=$SECONDS

if command -v npm.cmd >/dev/null 2>&1; then
  NPM="npm.cmd"
elif command -v npm >/dev/null 2>&1; then
  NPM="npm"
else
  echo "BUILD: FAILURE — npm/npm.cmd not found"
  exit 127
fi

run_build() {
  local label="$1"
  local directory="$2"
  local log="$VERIFY_DIR/build-$label.log"
  local status

  echo "BUILD_STEP $label: START ($NPM run build)"
  (cd "$directory" && "$NPM" run build) 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ]; then
    echo "BUILD_STEP $label: SUCCESS"
    return 0
  fi
  echo "BUILD_STEP $label: FAILURE (exit $status; log $log)"
  return "$status"
}

run_build root "$ROOT_DIR" || {
  status=$?
  echo "BUILD: FAILURE — root npm run build exited $status"
  exit "$status"
}

run_build server "$ROOT_DIR/server" || {
  status=$?
  echo "BUILD: FAILURE — server npm run build exited $status"
  exit "$status"
}

echo "BUILD_DURATION_SECONDS: $((SECONDS - STARTED_AT))"
echo "BUILD: SUCCESS"