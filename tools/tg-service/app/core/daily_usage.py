"""Per-account daily usage counters (P5-01).

Persistent, date-bucketed usage tracking shared by all hot-path engines
(DM, chat-broadcast, invite, boost, join, comment). Replaces the previous
per-run / in-memory counting which reset on every worker restart and never
spanned multiple campaigns for the same account.

Each engine reserves a slot with ``check_and_reserve`` *before* acting, so a
limit of e.g. 30 DMs/day is honoured even across several campaigns and worker
restarts. Counters auto-reset by virtue of the ``usage_date`` key — a new UTC
day simply has no rows yet, so the count starts at 0.

All functions are synchronous (Celery tasks run sync DB access) and never raise
on a missing table — a workspace DB created before this migration is treated as
"no usage yet" until the schema is re-applied.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import structlog

log = structlog.get_logger(__name__)

# Canonical action types — keep in sync with engine call-sites.
ACTION_DM = "dm"
ACTION_CHAT_POST = "chat_post"
ACTION_INVITE = "invite"
ACTION_COMMENT = "comment"
ACTION_BOOST = "boost"
ACTION_JOIN = "join"
ACTION_SUBSCRIPTION = "subscription"


def _today() -> str:
    """Current UTC date as YYYY-MM-DD (the daily reset bucket)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_usage(db: Any, account_id: str, action_type: str, day: str | None = None) -> int:
    """Return how many ``action_type`` actions ``account_id`` did today (UTC).

    Returns 0 if there's no row yet or the table doesn't exist.
    """
    day = day or _today()
    try:
        row = db.execute(
            "SELECT count FROM tg_account_daily_usage "
            "WHERE account_id = ? AND action_type = ? AND usage_date = ?",
            [account_id, action_type, day],
        ).fetchone()
        return int(row["count"]) if row else 0
    except Exception:  # noqa: BLE001 — missing table / transient → treat as 0
        return 0


def incr_usage(db: Any, account_id: str, action_type: str, n: int = 1, day: str | None = None) -> int:
    """Increment the counter by ``n`` and return the new total.

    Upserts the (account, action, date) row. Commits so the reservation is
    durable even if the surrounding task later fails. Returns the pre-existing
    count on error (best-effort — never raises into the hot path).
    """
    day = day or _today()
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            """INSERT INTO tg_account_daily_usage (account_id, action_type, usage_date, count, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(account_id, action_type, usage_date)
               DO UPDATE SET count = count + ?, updated_at = ?""",
            [account_id, action_type, day, n, now, n, now],
        )
        db.commit()
        return get_usage(db, account_id, action_type, day)
    except Exception:  # noqa: BLE001
        log.warning("daily_usage_incr_failed", account_id=account_id, action_type=action_type, exc_info=True)
        return get_usage(db, account_id, action_type, day)


def remaining(db: Any, account_id: str, action_type: str, limit: int, day: str | None = None) -> int:
    """How many more ``action_type`` actions are allowed today (>= 0)."""
    if limit <= 0:
        return 0
    return max(0, limit - get_usage(db, account_id, action_type, day))


def check_and_reserve(db: Any, account_id: str, action_type: str, limit: int, day: str | None = None) -> bool:
    """Atomically check the limit and reserve one slot.

    Returns True if the action is allowed (and increments the counter), False if
    the account already hit ``limit`` today. A non-positive ``limit`` means
    "unlimited" → always allowed, no counter kept.
    """
    if limit <= 0:
        return True
    day = day or _today()
    current = get_usage(db, account_id, action_type, day)
    if current >= limit:
        return False
    incr_usage(db, account_id, action_type, 1, day)
    return True
