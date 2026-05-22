/**
 * PM2 ecosystem configuration for TG Service.
 *
 * Three processes:
 *   1. pup-tg-api    — FastAPI (uvicorn, 2 workers)
 *   2. pup-tg-worker — Celery worker (4 concurrency, pup_tg_default queue)
 *   3. pup-tg-beat   — Celery Beat scheduler
 *
 * Start all:  pm2 start ecosystem.config.js
 * Restart:    pm2 restart ecosystem.config.js
 * Logs:       pm2 logs pup-tg-api
 */
module.exports = {
  apps: [
    // ── FastAPI ─────────────────────────────────────────────────────
    {
      name: "pup-tg-api",
      script: ".venv/bin/uvicorn",
      args: "app.main:app --host 127.0.0.1 --port 8001 --workers 2",
      cwd: __dirname,
      interpreter: "none",
      env: {
        PYTHONPATH: __dirname,
        PYTHONUNBUFFERED: "1",
      },
      out_file: "./logs/api-out.log",
      error_file: "./logs/api-error.log",
      merge_logs: true,
      max_memory_restart: "500M",
      autorestart: true,
      watch: false,
    },

    // ── Celery Worker ───────────────────────────────────────────────
    {
      name: "pup-tg-worker",
      script: ".venv/bin/celery",
      args: "-A app.tasks.celery_app worker --loglevel=info --queues=pup_tg_default --concurrency=4",
      cwd: __dirname,
      interpreter: "none",
      env: {
        PYTHONPATH: __dirname,
        PYTHONUNBUFFERED: "1",
      },
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-error.log",
      merge_logs: true,
      max_memory_restart: "1G",
      autorestart: true,
      watch: false,
      kill_timeout: 10000,
    },

    // ── Celery Beat ─────────────────────────────────────────────────
    {
      name: "pup-tg-beat",
      script: ".venv/bin/celery",
      args: "-A app.tasks.celery_app beat --loglevel=info",
      cwd: __dirname,
      interpreter: "none",
      env: {
        PYTHONPATH: __dirname,
        PYTHONUNBUFFERED: "1",
      },
      out_file: "./logs/beat-out.log",
      error_file: "./logs/beat-error.log",
      merge_logs: true,
      max_memory_restart: "300M",
      autorestart: true,
      watch: false,
    },
  ],
};
