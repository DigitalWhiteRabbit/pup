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


# ── Auto-discover DM campaign tasks ────────────────────────────────────────
def _register_dm_campaign_tasks() -> None:
    try:
        import app.tasks.dm_campaign_tasks  # noqa: F401

        log.info("celery_dm_campaign_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_dm_campaign_tasks_import_failed", exc_info=True)


_register_dm_campaign_tasks()


# ── Auto-discover chat broadcast tasks ────────────────────────────────────
def _register_chat_broadcast_tasks() -> None:
    try:
        import app.tasks.chat_broadcast_tasks  # noqa: F401

        log.info("celery_chat_broadcast_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_chat_broadcast_tasks_import_failed", exc_info=True)


_register_chat_broadcast_tasks()


# ── Auto-discover invite campaign tasks ───────────────────────────────────
def _register_invite_campaign_tasks() -> None:
    try:
        import app.tasks.invite_campaign_tasks  # noqa: F401

        log.info("celery_invite_campaign_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_invite_campaign_tasks_import_failed", exc_info=True)


_register_invite_campaign_tasks()


# ── Auto-discover commenting tasks ─────────────────────────────────────────
def _register_commenting_tasks() -> None:
    """Import commenting_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.commenting_tasks  # noqa: F401, WPS433

        log.info("celery_commenting_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_commenting_tasks_import_failed", exc_info=True)


_register_commenting_tasks()


# ── Auto-discover auto-replier tasks ──────────────────────────────────────
def _register_auto_replier_tasks() -> None:
    try:
        import app.tasks.auto_replier_tasks  # noqa: F401

        log.info("celery_auto_replier_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_auto_replier_tasks_import_failed", exc_info=True)


_register_auto_replier_tasks()


# ── Auto-discover AI promoter tasks ──────────────────────────────────────
def _register_ai_promoter_tasks() -> None:
    """Import ai_promoter_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.ai_promoter_tasks  # noqa: F401, WPS433

        log.info("celery_ai_promoter_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_ai_promoter_tasks_import_failed", exc_info=True)


_register_ai_promoter_tasks()


# ── Auto-discover unified AI agent tasks ──────────────────────────────────
def _register_ai_agent_tasks() -> None:
    try:
        import app.tasks.ai_agent_tasks  # noqa: F401

        log.info("celery_ai_agent_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_ai_agent_tasks_import_failed", exc_info=True)


_register_ai_agent_tasks()


# ── Auto-discover stage5 tasks (boost, stories, cloner, channel creator, converter)
def _register_stage5_tasks() -> None:
    try:
        import app.tasks.stage5_tasks  # noqa: F401

        log.info("celery_stage5_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_stage5_tasks_import_failed", exc_info=True)


_register_stage5_tasks()


# ── Auto-discover AI sales tasks ─────────────────────────────────────────
def _register_ai_sales_tasks() -> None:
    """Import ai_sales_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.ai_sales_tasks  # noqa: F401, WPS433

        log.info("celery_ai_sales_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_ai_sales_tasks_import_failed", exc_info=True)


_register_ai_sales_tasks()


# ── Auto-discover unified AI agent tasks ──────────────────────────────────
def _register_ai_agent_tasks() -> None:
    """Import ai_agent_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.ai_agent_tasks  # noqa: F401, WPS433

        log.info("celery_ai_agent_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_ai_agent_tasks_import_failed", exc_info=True)


_register_ai_agent_tasks()


# ── Auto-discover join chats tasks ───────────────────────────────────────────
def _register_join_chats_tasks() -> None:
    """Import join_chats_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.join_chats_tasks  # noqa: F401, WPS433

        log.info("celery_join_chats_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_join_chats_tasks_import_failed", exc_info=True)


_register_join_chats_tasks()


# ── Auto-discover warmup script tasks ─────────────────────────────────────
def _register_warmup_script_tasks() -> None:
    """Import warmup_script_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.warmup_script_tasks  # noqa: F401, WPS433

        log.info("celery_warmup_script_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_warmup_script_tasks_import_failed", exc_info=True)


_register_warmup_script_tasks()


# ── Auto-discover KB crawl tasks ──────────────────────────────────────────
def _register_kb_crawl_tasks() -> None:
    """Import kb_crawl_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.kb_crawl_tasks  # noqa: F401, WPS433

        log.info("celery_kb_crawl_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_kb_crawl_tasks_import_failed", exc_info=True)


_register_kb_crawl_tasks()


# ── Auto-discover KB conflict tasks ───────────────────────────────────────
def _register_kb_conflict_tasks() -> None:
    """Import kb_conflict_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.kb_conflict_tasks  # noqa: F401, WPS433

        log.info("celery_kb_conflict_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_kb_conflict_tasks_import_failed", exc_info=True)


_register_kb_conflict_tasks()


# ── Auto-discover KB self-test tasks ──────────────────────────────────────
def _register_kb_selftest_tasks() -> None:
    """Import kb_selftest_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.kb_selftest_tasks  # noqa: F401, WPS433

        log.info("celery_kb_selftest_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_kb_selftest_tasks_import_failed", exc_info=True)


_register_kb_selftest_tasks()


# ── Auto-discover style-bank tasks ────────────────────────────────────────
def _register_style_tasks() -> None:
    """Import style_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.style_tasks  # noqa: F401, WPS433

        log.info("celery_style_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_style_tasks_import_failed", exc_info=True)


_register_style_tasks()


# ── Auto-discover arena (multi-agent self-play) tasks ─────────────────────
def _register_arena_tasks() -> None:
    """Import arena_tasks so its @celery_app.task decorators register."""
    try:
        import app.tasks.arena_tasks  # noqa: F401, WPS433

        log.info("celery_arena_tasks_registered")
    except Exception:  # noqa: BLE001
        log.warning("celery_arena_tasks_import_failed", exc_info=True)


_register_arena_tasks()


# ── Connectivity check on startup ───────────────────────────────────────────
@worker_ready.connect
def _on_worker_ready(**kwargs: object) -> None:
    log.info("celery_worker_ready", broker=settings.celery_broker_url)
    # Self-heal: a worker restart drops the AI-agent self-loop's pending ETA
    # task, so ACTIVE personas stop acting until manually re-activated. Kick the
    # reaper a few seconds after the worker is up to revive any dead loops — this
    # makes the loop survive restarts WITHOUT requiring a separate Beat process.
    try:
        celery_app.send_task(
            "pup_tg.ai_agent_reaper",
            kwargs={"force": True},
            queue="pup_tg_default",
            countdown=10,
        )
        log.info("worker_ready_reaper_dispatched")
    except Exception:  # noqa: BLE001
        log.warning("worker_ready_reaper_dispatch_failed", exc_info=True)


# ── Smoke-test task ─────────────────────────────────────────────────────────
@celery_app.task(name="pup_tg.echo")
def echo(message: str) -> str:
    """Simple echo task for smoke testing.  Returns the input unchanged."""
    log.info("echo_task_executed", message=message)
    return message
