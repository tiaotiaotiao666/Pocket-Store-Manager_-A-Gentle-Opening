#!/usr/bin/env bash
set -euo pipefail
npm run build
npm --prefix server run build