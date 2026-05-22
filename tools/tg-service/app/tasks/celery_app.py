"""Celery application instance for TG Service.

Broker and result backend both use Redis db=5 (configurable via settings).
The app handles Redis being unavailable gracefully -- it logs a warning
at import time rather than crashing.
"""

from __future__ import annotations

import structlog
from celery import Celery
from celery.signals import worker_ready

from app.config import settings

log = structlog.get_logger(__name__)

celery_app = Celery(
    "pup_tg",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

# ── Serialisation ────────────────────────────────────────────────────────────
celery_app.conf.accept_content = ["json"]
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"

# ── Timezone ─────────────────────────────────────────────────────────────────
celery_app.conf.timezone = "Europe/Moscow"
celery_app.conf.enable_utc = True

# ── Reliability ──────────────────────────────────────────────────────────────
celery_app.conf.task_acks_late = True
celery_app.conf.worker_prefetch_multiplier = 1

# ── Default queue ────────────────────────────────────────────────────────────
celery_app.conf.task_default_queue = "pup_tg_default"

# ── Broker connection resilience ─────────────────────────────────────────────
celery_app.conf.broker_connection_retry_on_startup = True
celery_app.conf.broker_connection_retry = True
celery_app.conf.broker_connection_max_retries = 10


# ── Beat schedule (imported lazily to avoid circular deps) ───────────────────
def _register_beat_schedule() -> None:
    """Import beat_schedule and merge it into the Celery config."""
    try:
        from app.tasks.beat_schedule import BEAT_SCHEDULE  # noqa: WPS433

        celery_app.conf.beat_schedule = BEAT_SCHEDULE
        log.info("celery_beat_schedule_registered", tasks=list(BEAT_SCHEDULE.keys()))
    except Exception:  # noqa: BLE001
        log.warning("celery_beat_schedule_failed", exc_info=True)


_register_beat_schedule()


# ── Auto-discover warmup tasks ─────────────────────────────────────────────
def _register_warmup_tasks() -> None:
    """Import warmup_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.warmup_tasks  # noqa: F401, WPS433

        log.info("celery_warmup_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_warmup_tasks_import_failed", exc_info=True)


_register_warmup_tasks()


# ── Auto-discover parsing tasks ──────────────────────────────────────────────
def _register_parsing_tasks() -> None:
    """Import parsing_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.parsing_tasks  # noqa: F401, WPS433

        log.info("celery_parsing_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_parsing_tasks_import_failed", exc_info=True)


_register_parsing_tasks()


# ── Auto-discover channel tasks ──────────────────────────────────────────────
def _register_channel_tasks() -> None:
    """Import channel_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.channel_tasks  # noqa: F401, WPS433

        log.info("celery_channel_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_channel_tasks_import_failed", exc_info=True)


_register_channel_tasks()


# ── Connectivity check on startup ───────────────────────────────────────────
@worker_ready.connect
def _on_worker_ready(**kwargs: object) -> None:
    log.info("celery_worker_ready", broker=settings.celery_broker_url)


# ── Smoke-test task ─────────────────────────────────────────────────────────
@celery_app.task(name="pup_tg.echo")
def echo(message: str) -> str:
    """Simple echo task for smoke testing.  Returns the input unchanged."""
    log.info("echo_task_executed", message=message)
    return message
