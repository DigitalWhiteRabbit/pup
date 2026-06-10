"""Best-effort admin notifications via a Telegram bot.

A single sync helper, :func:`notify_admin`, used from Celery tasks (and, if ever
needed, request handlers) to DM the operator on key events — a join campaign
finishing, an account getting banned, an agent auto-pausing.

Design rules:
- **Optional**: when ``notify_bot_token`` / ``notify_chat_id`` are unset it is a
  silent no-op, so the service runs fine without a bot configured.
- **Best-effort**: every failure is swallowed (logged at most). A notification
  must never break the work that triggered it.
- **Sync**: callers are mostly Celery prefork tasks. The HTTP call to
  api.telegram.org is quick and rare; we keep it synchronous for simplicity.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import structlog

from app.config import settings

log = structlog.get_logger(__name__)


# event_key → tg_settings field. Column-backed keys read the real column;
# the rest live in the ``extra_settings`` JSON blob (written by the settings
# form, see P1-09). Unknown keys default to enabled (send) for safety.
_EVENT_TO_PREF = {
    "emergency_stop": "notify_on_emergency_stop",   # real column
    "spam_block": "notify_on_spam_block",           # real column
    "hot_lead": "notif_hot_lead",                   # extra_settings
    "approval_queue": "notif_approval_queue",        # extra_settings
    "warmup_ready": "notif_warmup_ready",            # extra_settings
    "daily_digest": "notif_daily_digest",            # extra_settings
    "ai_budget": "notif_ai_budget",                  # extra_settings
    "long_task": "notif_long_task",                  # extra_settings
}


def _pref_enabled(db: Any, event_key: str) -> bool:
    """True if the operator wants notifications for ``event_key`` (default True).

    Reads the matching tg_settings column or the ``extra_settings`` JSON flag.
    Any error or missing value → True so we never silently swallow alerts.
    """
    pref = _EVENT_TO_PREF.get(event_key)
    if not pref:
        return True
    try:
        row = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
        if not row:
            return True
        keys = row.keys()
        if pref in keys:
            val = row[pref]
            return True if val is None else bool(val)
        # Otherwise look inside extra_settings JSON.
        if "extra_settings" in keys and row["extra_settings"]:
            extra = json.loads(row["extra_settings"])
            if isinstance(extra, dict) and pref in extra:
                return bool(extra[pref])
        return True
    except Exception:  # noqa: BLE001
        return True


def notify_admin_pref(db: Any, event_key: str, text: str, *, parse_mode: str | None = "HTML") -> bool:
    """Send ``text`` only if the operator enabled notifications for ``event_key``.

    Thin preference gate over :func:`notify_admin` (P2-10). Default-on: an
    unknown key or unreadable settings still sends, so this never hides an alert
    the operator didn't explicitly disable.
    """
    if not _pref_enabled(db, event_key):
        log.info("notify_suppressed_by_pref", pref_event=event_key)
        return False
    return notify_admin(text, parse_mode=parse_mode)


def notify_admin(text: str, *, parse_mode: str | None = "HTML") -> bool:
    """Send ``text`` to the configured admin chat. Returns True if sent.

    No-op (returns False) when the bot token or chat id is not configured, or
    on any transport error — this is intentionally swallowed so notification
    problems never propagate into the calling task.
    """
    token = (settings.notify_bot_token or "").strip()
    chat_id = (settings.notify_chat_id or "").strip()
    if not token or not chat_id:
        return False

    payload: dict[str, object] = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload,
            )
        if resp.status_code == 200:
            return True
        log.warning("notify_admin_bad_status", status_code=resp.status_code, body=resp.text[:200])
        return False
    except Exception:  # noqa: BLE001
        log.warning("notify_admin_failed", exc_info=True)
        return False
