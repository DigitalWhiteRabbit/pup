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


# Maps an action_type to the tg_settings column holding its per-day limit.
# Actions without a settings limit (boost actions etc.) fall back to 0 = unlimited.
_ACTION_LIMIT_COL = {
    ACTION_DM: "limits_dm_per_day",
    ACTION_CHAT_POST: "limits_chat_posts_per_day",
    ACTION_COMMENT: "limits_comments_per_day",
    ACTION_INVITE: "limits_invites_per_day",
    ACTION_JOIN: "limits_subscriptions_per_day",
    ACTION_SUBSCRIPTION: "limits_subscriptions_per_day",
}


def _settings_active_now(db: Any) -> bool:
    """True if the current UTC hour is within tg_settings.active_hours.

    Format ``"HH:MM-HH:MM"`` (only the hour part is used). Missing/unparseable
    settings → always active (no gate). Handles windows that wrap past midnight.
    """
    try:
        row = db.execute(
            "SELECT active_hours FROM tg_settings WHERE id = 'default'"
        ).fetchone()
    except Exception:
        return True
    if not row or not row["active_hours"] or "-" not in row["active_hours"]:
        return True
    try:
        start_s, end_s = row["active_hours"].split("-", 1)
        h_start = int(start_s.split(":")[0]) % 24
        h_end = int(end_s.split(":")[0]) % 24
    except (ValueError, IndexError):
        return True
    if h_start == h_end:
        return True
    cur = datetime.now(timezone.utc).hour
    if h_start < h_end:
        return h_start <= cur < h_end
    return cur >= h_start or cur < h_end


def can_act(db: Any, account_id: str, action_type: str, limit: int | None = None) -> tuple[bool, str]:
    """Unified gate for hot-path engines (P5-03): active hours + daily limit.

    Combines the global active-hours window with the per-account persistent daily
    cap. ``limit`` overrides the settings-derived limit when given; otherwise the
    limit is looked up from tg_settings via ``_ACTION_LIMIT_COL`` (0 = unlimited).

    Returns ``(allowed, reason)`` where ``reason`` is "" on success or a short
    machine-readable tag ("outside_active_hours" / "daily_limit_reached") to log.
    """
    if not _settings_active_now(db):
        return False, "outside_active_hours"

    eff_limit = limit
    if eff_limit is None:
        col = _ACTION_LIMIT_COL.get(action_type)
        eff_limit = 0
        if col:
            try:
                row = db.execute(
                    f"SELECT {col} AS lim FROM tg_settings WHERE id = 'default'"
                ).fetchone()
                eff_limit = int(row["lim"]) if row and row["lim"] is not None else 0
            except Exception:
                eff_limit = 0

    if eff_limit and get_usage(db, account_id, action_type) >= eff_limit:
        return False, "daily_limit_reached"

    return True, ""
