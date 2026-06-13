#!/bin/bash
# deploy.sh — Production deploy for PUP + YT-Parser (unified Prisma/Postgres).
# Called via webhook (/var/www/deploy.sh wrapper → exec this) or manually.
# Features: flock, timeout, guaranteed restart, logging.
#
# Архитектура после Батча 3 (унификация БД):
#   - парсер запускается IN-PLACE из /var/www/pup/tools/yt-parser (НЕ /var/www/yt-parser);
#   - схема приводится через `prisma migrate deploy` (история resolved, обычно no-op);
#   - нативные модули (better-sqlite3/sharp/bcrypt) собираются pnpm-ом благодаря
#     pnpm.onlyBuiltDependencies в package.json (корневой и tools/yt-parser).

set -o pipefail

# --- Self-snapshot: Step 1 делает `git reset --hard`, который может перезаписать
# этот файл на лету (webhook запускает нас как exec репо-скрипта). Запускаемся из
# неизменяемой копии в /tmp, чтобы git не «выдернул ковёр» из-под исполнения. ---
if [ "${DEPLOY_REEXEC:-}" != "1" ]; then
  SNAP="/tmp/deploy-run.$$.sh"
  cp "$0" "$SNAP" 2>/dev/null && DEPLOY_REEXEC=1 exec bash "$SNAP" "$@"
fi

LOCKFILE="/tmp/deploy.lock"
LOGFILE="/var/www/deploy.log"
PUP_DIR="/var/www/pup"
YT_DIR="$PUP_DIR/tools/yt-parser"   # парсер in-place внутри репо (НЕ /var/www/yt-parser)
BUILD_TIMEOUT=300  # 5 minutes

# --- Logging helpers ---
log() { echo "$(date "+%Y-%m-%d %H:%M:%S") | $1" >> "$LOGFILE"; }

# --- Telegram live progress ---
# pup is stopped during the build, so deploy.sh (not an in-process timer) drives
# the progress bar. pup's onDeployStarted wrote /tmp/pup-deploy.json with the
# recipients; this edits those messages per real stage. See deploy-progress.js.
TG_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PUP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
tg_progress() {
  [ -n "$TG_TOKEN" ] && TELEGRAM_BOT_TOKEN="$TG_TOKEN" \
    node "$PUP_DIR/scripts/deploy-progress.js" "$1" >> "$LOGFILE" 2>&1 || true
}

# --- Lock: only one deploy at a time ---
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "SKIPPED — another deploy is already running"
  exit 0
fi

# Write PID for debugging
echo $$ > /tmp/deploy.pid

log "========================================="
log "DEPLOY STARTED (PID $$)"

# --- Guaranteed restart on ANY exit ---
# Перезапускаем оба процесса ИЗ их сохранённого pm2-конфига (cwd), а НЕ
# пересоздаём из старых путей. yt-parser живёт из /var/www/pup/tools/yt-parser.
cleanup() {
  local exit_code=$?
  log "Cleanup triggered (exit_code=$exit_code)"

  # Progress: services coming back up (step 3 = "Запуск контейнера").
  tg_progress 3

  # pup
  pm2 restart pup >> "$LOGFILE" 2>&1 || pm2 start pup >> "$LOGFILE" 2>&1 || true
  # yt-parser — restart из сохранённого cwd; fallback: старт из репо-пути
  pm2 restart yt-parser >> "$LOGFILE" 2>&1 \
    || ( cd "$YT_DIR" && pm2 start ecosystem.config.js >> "$LOGFILE" 2>&1 ) || true

  # Wait a bit and verify they are running
  sleep 3
  if pm2 pid pup > /dev/null 2>&1; then
    log "pup: RUNNING (pid $(pm2 pid pup))"
  else
    log "pup: FAILED TO START — attempting restart"
    pm2 restart pup >> "$LOGFILE" 2>&1 || true
  fi

  if pm2 pid yt-parser > /dev/null 2>&1; then
    log "yt-parser: RUNNING (pid $(pm2 pid yt-parser))"
  else
    log "yt-parser: FAILED TO START — attempting restart"
    pm2 restart yt-parser >> "$LOGFILE" 2>&1 \
      || ( cd "$YT_DIR" && pm2 start ecosystem.config.js >> "$LOGFILE" 2>&1 ) || true
  fi

  pm2 save >> "$LOGFILE" 2>&1 || true
  rm -f "$SNAP" 2>/dev/null || true
  if [ $exit_code -eq 0 ]; then
    log "DEPLOY FINISHED: OK"
  else
    log "DEPLOY FINISHED: FAILED (exit_code=$exit_code)"
  fi
  log "========================================="

  # Release lock
  flock -u 9
}
trap cleanup EXIT

# --- Step 1: Git — чистое отслеживание main ---
# fetch + checkout main + hard-reset на origin/main; снимаем легаси-stash'и
# (включая P4b-хотфикс — он уже в main как коммит).
log "Step 1/5: git fetch + checkout main + reset --hard origin/main"
cd "$PUP_DIR" || exit 1
git fetch origin >> "$LOGFILE" 2>&1 || { log "FATAL: git fetch failed"; exit 1; }
git checkout main >> "$LOGFILE" 2>&1 || { log "FATAL: git checkout main failed"; exit 1; }
git reset --hard origin/main >> "$LOGFILE" 2>&1 || { log "FATAL: git reset failed"; exit 1; }
git stash clear >> "$LOGFILE" 2>&1 || true

# --- Step 2: Stop services to free RAM ---
log "Step 2/5: stopping services"
pm2 stop pup >> "$LOGFILE" 2>&1 || true
pm2 stop yt-parser >> "$LOGFILE" 2>&1 || true
sleep 2

# --- Step 3: PUP deps + Prisma (схема уже postgresql в репо — sed не нужен) ---
log "Step 3/5: pnpm install + prisma generate + migrate deploy (PUP)"
tg_progress 1  # "Установка зависимостей"
pnpm install --frozen-lockfile >> "$LOGFILE" 2>&1
npx prisma generate >> "$LOGFILE" 2>&1
# migrate deploy — применяет pending-миграции; история resolved → обычно no-op.
# (Заменяет прежний `db push --accept-data-loss`, который мог снести данные.)
npx prisma migrate deploy >> "$LOGFILE" 2>&1 || log "WARN: prisma migrate deploy non-zero (см. лог)"

# --- Step 4: Build with timeout ---
log "Step 4/5: building (timeout=${BUILD_TIMEOUT}s)"
tg_progress 2  # "Сборка проекта"
rm -rf .next

export NODE_OPTIONS="--max-old-space-size=3072"
if timeout "$BUILD_TIMEOUT" pnpm build >> "$LOGFILE" 2>&1; then
  log "Build: SUCCESS"
else
  BUILD_EXIT=$?
  if [ $BUILD_EXIT -eq 124 ]; then
    log "Build: TIMEOUT after ${BUILD_TIMEOUT}s"
  else
    log "Build: FAILED (exit_code=$BUILD_EXIT)"
  fi
  # cleanup trap will restart services
  exit 1
fi
unset NODE_OPTIONS

# --- Step 5: Парсер in-place (deps) — БЕЗ rsync на /var/www/yt-parser ---
# Код парсера обновился вместе с git pull (он внутри репо tools/yt-parser).
# Его .env / data / api-keys.db остаются (gitignored). Нативные модули
# (better-sqlite3/sharp) соберутся через pnpm.onlyBuiltDependencies.
# Prisma-клиент парсера уже сгенерён шагом 3 (общий `prisma generate`).
log "Step 5/5: yt-parser deps (in-place)"
( cd "$YT_DIR" && pnpm install --frozen-lockfile >> "$LOGFILE" 2>&1 ) \
  || log "WARN: yt-parser pnpm install non-zero (см. лог)"

# cleanup trap will restart both services
exit 0
