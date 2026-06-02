#!/usr/bin/env bash
#
# dev-up.sh — поднять TG Service локально БЕЗ Redis.
#
# Запускает два процесса:
#   1. FastAPI (uvicorn :8001)
#   2. Celery worker — на filesystem-брокере (очередь в data/broker/, Redis не нужен)
#
# Это закрывает главную проблему локалки: без воркера кнопки «Старт» переводят
# задачу в ACTIVE, но никто её не исполняет. Здесь воркер реально крутится.
#
#   Запуск:    ./scripts/dev-up.sh
#   Логи:      tail -f logs/api.log logs/worker.log
#   Остановка: ./scripts/dev-down.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENV="$ROOT/.venv/bin"
RUN_DIR="$ROOT/data/run"
mkdir -p "$RUN_DIR" "$ROOT/logs"

# Локальный движок без Redis: filesystem-брокер.
# (Чтобы использовать настоящий Redis — не задавайте эту переменную / правьте .env.)
export CELERY_BROKER_URL="${CELERY_BROKER_URL:-filesystem://}"
export PYTHONPATH="$ROOT"
export PYTHONUNBUFFERED=1

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ── API ──────────────────────────────────────────────────────────────────────
API_PID="$RUN_DIR/api.pid"
if is_running "$API_PID"; then
  echo "• API уже запущен (pid $(cat "$API_PID"))"
else
  "$VENV/uvicorn" app.main:app --host 127.0.0.1 --port 8001 \
    >"$ROOT/logs/api.log" 2>&1 &
  echo $! >"$API_PID"
  echo "• API запущен (pid $(cat "$API_PID")) → http://127.0.0.1:8001"
fi

# ── Celery worker ──────────────────────────────────────────────────────────────
WORKER_PID="$RUN_DIR/worker.pid"
if is_running "$WORKER_PID"; then
  echo "• Worker уже запущен (pid $(cat "$WORKER_PID"))"
else
  # threads-пул: реальный параллелизм без fork (на macOS prefork капризен),
  # подходит для IO-bound задач (Telethon + Claude API). Долгие агентные циклы
  # не блокируют парсер/рассылки/echo.
  "$VENV/celery" -A app.tasks.celery_app worker \
    --loglevel=info --queues=pup_tg_default --concurrency=4 --pool=threads \
    >"$ROOT/logs/worker.log" 2>&1 &
  echo $! >"$WORKER_PID"
  echo "• Worker запущен (pid $(cat "$WORKER_PID")), брокер: $CELERY_BROKER_URL"
fi

sleep 2
echo ""
echo "Готово. Проверка движка:"
echo "  curl -s http://127.0.0.1:8001/api/v1/system/status -H 'x-admin-token:dev-admin-token-12345' | python3 -m json.tool"
