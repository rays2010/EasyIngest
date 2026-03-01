#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST="${1:-home}"
REMOTE_DIR="${2:-/volume3/docker/EasyIngest}"
HOST_PORT="${HOST_PORT:-3030}"

cd "$PROJECT_DIR"

tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='tasks' \
  --exclude='.env' \
  -czf - . | ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR' && tar -xzf - -C '$REMOTE_DIR'"

ssh "$REMOTE_HOST" "
  set -euo pipefail
  cd '$REMOTE_DIR'
  [ -f .env ] || cp .env.example .env
  if grep -q '^HOST_PORT=' .env; then sed -i 's/^HOST_PORT=.*/HOST_PORT=$HOST_PORT/' .env; else echo 'HOST_PORT=$HOST_PORT' >> .env; fi
  if grep -q '^PORT=' .env; then sed -i 's/^PORT=.*/PORT=3000/' .env; else echo 'PORT=3000' >> .env; fi
  if grep -q '^INPUT_HOST_DIR=' .env; then sed -i 's|^INPUT_HOST_DIR=.*|INPUT_HOST_DIR=$REMOTE_DIR/input|' .env; else echo 'INPUT_HOST_DIR=$REMOTE_DIR/input' >> .env; fi
  if grep -q '^OUTPUT_HOST_DIR=' .env; then sed -i 's|^OUTPUT_HOST_DIR=.*|OUTPUT_HOST_DIR=$REMOTE_DIR/output|' .env; else echo 'OUTPUT_HOST_DIR=$REMOTE_DIR/output' >> .env; fi
  mkdir -p input output tasks logs
  sudo -n /usr/local/bin/docker compose up -d --build
  sudo -n /usr/local/bin/docker compose ps
"
