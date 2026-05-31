#!/bin/bash
# deploy.sh — Production deploy for PUP + YT-Parser
# Called via webhook (nohup detached) or manually.
# Features: flock, timeout, guaranteed restart, logging.

set -o pipefail

LOCKFILE="/tmp/deploy.lock"
LOGFILE="/var/www/deploy.log"
PUP_DIR="/var/www/pup"
YT_DIR="/var/www/yt-parser"
BUILD_TIMEOUT=300  # 5 minutes

# --- Logging helpers ---
log() { echo "$(date "+%Y-%m-%d %H:%M:%S") | $1" >> "$LOGFILE"; }

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
cleanup() {
  local exit_code=$?
  log "Cleanup triggered (exit_code=$exit_code)"

  # Always start services back
  pm2 start pup >> "$LOGFILE" 2>&1 || true
  pm2 startOrRestart "$YT_DIR/ecosystem.config.js" >> "$LOGFILE" 2>&1 || true

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
    ( cd "$YT_DIR" && pm2 startOrRestart ecosystem.config.js >> "$LOGFILE" 2>&1 ) || true
  fi

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

# --- Step 1: Git pull ---
log "Step 1/6: git pull"
cd "$PUP_DIR" || exit 1
git stash >> "$LOGFILE" 2>&1 || true
if ! git pull origin main >> "$LOGFILE" 2>&1; then
  log "FATAL: git pull failed"
  exit 1
fi

# --- Step 2: Fix Prisma provider for PostgreSQL ---
log "Step 2/6: prisma provider swap"
sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma 2>/dev/null

# --- Step 3: Stop services to free RAM ---
log "Step 3/6: stopping services"
pm2 stop pup >> "$LOGFILE" 2>&1 || true
pm2 stop yt-parser >> "$LOGFILE" 2>&1 || true
sleep 2

# --- Step 4: Install deps + Prisma ---
log "Step 4/6: pnpm install + prisma"
pnpm install --frozen-lockfile >> "$LOGFILE" 2>&1
npx prisma generate >> "$LOGFILE" 2>&1
npx prisma db push --accept-data-loss >> "$LOGFILE" 2>&1 || true

# --- Step 5: Build with timeout ---
log "Step 5/6: building (timeout=${BUILD_TIMEOUT}s)"
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

# --- Step 6: Sync yt-parser ---
log "Step 6/6: syncing yt-parser"
rsync -a --delete \
  --exclude=node_modules \
  --exclude=data \
  --exclude=.env \
  --exclude=cache.json \
  --exclude="*.db" \
  --exclude=presets.json \
  "$PUP_DIR/tools/yt-parser/" "$YT_DIR/" 2>> "$LOGFILE"

cd "$YT_DIR" && npm install --production >> "$LOGFILE" 2>&1

# cleanup trap will start both services
exit 0
