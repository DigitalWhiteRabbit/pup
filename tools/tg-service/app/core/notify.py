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

import httpx
import structlog

from app.config import settings

log = structlog.get_logger(__name__)


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
