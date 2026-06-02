"""System status endpoints — health of the background-task engine.

Surfaces whether the Celery broker is reachable and whether a worker is online,
so the UI can warn the user when "Старт" actions would not actually execute.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from app.config import settings
from app.deps import AdminAuth

router = APIRouter(tags=["system"])

# Pinging the worker over the broker is slow (esp. the filesystem broker, ~3s),
# so cache the result briefly to keep the polled endpoint cheap.
_CACHE: dict[str, Any] = {"ts": 0.0, "value": None}
_CACHE_TTL = 15.0


def _probe_engine() -> dict[str, Any]:
    """Check broker reachability and whether at least one worker responds."""
    from app.tasks.celery_app import celery_app

    broker_reachable = False
    worker_online = False
    workers: list[str] = []
    error: str | None = None

    try:
        conn = celery_app.connection()
        conn.ensure_connection(max_retries=1, timeout=2)
        conn.release()
        broker_reachable = True
    except Exception as exc:  # noqa: BLE001
        error = f"broker: {exc}"

    if broker_reachable:
        try:
            replies = celery_app.control.ping(timeout=3.0) or []
            workers = [name for r in replies for name in r.keys()]
            worker_online = len(workers) > 0
        except Exception as exc:  # noqa: BLE001
            error = f"ping: {exc}"

    return {
        "broker_reachable": broker_reachable,
        "worker_online": worker_online,
        "workers": workers,
        "broker_url": str(settings.celery_broker_url),
        "error": error,
    }


@router.get("/system/status")
def system_status(_token: AdminAuth) -> dict[str, Any]:
    """Background-engine health (admin only). Cached ~15s; runs in a threadpool."""
    now = time.monotonic()
    if _CACHE["value"] is not None and (now - _CACHE["ts"]) < _CACHE_TTL:
        return {**_CACHE["value"], "cached": True}
    value = _probe_engine()
    _CACHE["ts"] = now
    _CACHE["value"] = value
    return {**value, "cached": False}
