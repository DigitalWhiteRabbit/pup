"""Celery Beat periodic task schedule for TG Service."""

from __future__ import annotations

import structlog
from celery import shared_task
from celery.schedules import crontab

log = structlog.get_logger(__name__)


# ── Periodic tasks ───────────────────────────────────────────────────────────


@shared_task(name="pup_tg.beat_heartbeat")
def beat_heartbeat() -> str:
    """One-minute heartbeat -- proves Celery Beat is alive."""
    log.info("beat_heartbeat", status="alive")
    return "beat_heartbeat"


# ── Schedule registry ────────────────────────────────────────────────────────

BEAT_SCHEDULE: dict[str, dict[str, object]] = {
    "heartbeat-every-minute": {
        "task": "pup_tg.beat_heartbeat",
        "schedule": 60.0,  # every 60 seconds
        "options": {"queue": "pup_tg_default"},
    },
    "warmup-check-every-hour": {
        "task": "pup_tg.warmup_check",
        "schedule": crontab(minute=0),  # every hour at :00
        "options": {"queue": "pup_tg_default"},
    },
}
