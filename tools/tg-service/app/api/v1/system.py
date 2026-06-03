"""System status endpoints — health of the background-task engine.

Surfaces whether the Celery broker is reachable and whether a worker is online,
so the UI can warn the user when "Старт" actions would not actually execute.
"""

from __future__ import annotations

import os
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


def _local_worker_pid() -> int | None:
    """Return the PID of a worker started by dev-up.sh, if it is alive.

    Fast, broker-agnostic liveness signal for local dev — avoids a slow
    control.ping (and, on the filesystem broker, avoids leaving pidbox reply
    files in the queue on every poll).
    """
    pidfile = settings.data_dir / "run" / "worker.pid"
    try:
        pid = int(pidfile.read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)  # signal 0 = liveness probe, does not kill
    except OSError:
        return None
    return pid


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

    # Prefer the local pidfile (instant, no broker chatter). Fall back to a
    # control.ping for setups not started by dev-up.sh (e.g. PM2 in prod).
    local_pid = _local_worker_pid()
    if local_pid is not None:
        worker_online = True
        workers = [f"local:{local_pid}"]
    elif broker_reachable:
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


@router.get("/system/enums")
def system_enums(_token: AdminAuth) -> dict[str, Any]:
    """Canonical enum source-of-truth for the frontend (P5-06).

    The UI hardcodes status/mode dictionaries in JS which can drift from the
    backend's accepted values (the P1-03 parser-mode mismatch was exactly this).
    This endpoint exposes the authoritative sets pulled straight from the
    validating modules, so the UI can fetch + reconcile on load.
    """
    def _safe(getter: Any) -> list[str]:
        try:
            return sorted(getter())
        except Exception:  # noqa: BLE001
            return []

    from app.api.v1 import parser as _parser

    enums: dict[str, Any] = {
        "parser_modes": _safe(lambda: _parser.VALID_MODES),
        "parser_statuses": _safe(lambda: _parser.VALID_STATUSES),
        # Account lifecycle (kept in sync with schema.sql comment + UI ASL/ASC).
        "account_statuses": [
            "IMPORTED", "ACTIVE", "WARMING", "PAUSED", "FLOOD_WAIT",
            "SPAM_BLOCKED", "BANNED", "DEAD", "INVALID", "NO_PROXY",
        ],
        "proxy_statuses": ["ACTIVE", "DEAD", "PAUSED", "EXPIRED"],
        "proxy_types": ["RESIDENTIAL", "MOBILE", "DATACENTER", "ISP"],
        "proxy_schemes": ["socks5", "socks4", "http", "https", "mtproto"],
        "channel_types": ["CHANNEL", "SUPERGROUP", "BASIC_GROUP", "FORUM"],
        "channel_roles": ["SOURCE", "TARGET", "BOTH", "NONE"],
        "campaign_statuses": [
            "DRAFT", "SCHEDULED", "RUNNING", "PAUSED",
            "COMPLETED", "STOPPED", "EMERGENCY_STOPPED",
        ],
        "boost_types": ["SUBSCRIBERS", "REACTIONS", "VIEWS", "POLL_VOTES"],
        "daily_usage_actions": [
            "dm", "chat_post", "invite", "comment", "boost", "join", "subscription",
        ],
    }
    return {"enums": enums}
