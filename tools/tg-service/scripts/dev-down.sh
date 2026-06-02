#!/usr/bin/env bash
#
# dev-down.sh — остановить процессы, поднятые dev-up.sh (API + Celery worker).
#
set -euo pipefail

cd "$(dirname "$0")/.."
RUN_DIR="$(pwd)/data/run"

stop() {
  local name="$1" pidfile="$2"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    echo "• $name остановлен (pid $(cat "$pidfile"))"
  else
    echo "• $name не запущен"
  fi
  rm -f "$pidfile"
}

stop "Worker" "$RUN_DIR/worker.pid"
stop "API" "$RUN_DIR/api.pid"
