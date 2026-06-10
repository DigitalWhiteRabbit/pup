"""Singleton settings endpoint for TG Service workspace configuration."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# UI ↔ column bridge
# ---------------------------------------------------------------------------
# The settings form historically used field names that don't match the DB
# columns, so almost the whole form was silently dropped. We translate the UI
# aliases to real columns on PATCH and echo both names on GET. UI-only fields
# with no column (delays, extra notif flags, ...) are persisted in the
# ``extra_settings`` JSON column instead of being discarded.

# Real columns we expose for direct read/write.
_REAL_COLUMNS = {
    "ai_default_model", "ai_model_roles", "limits_dm_per_day",
    "limits_chat_posts_per_day", "limits_comments_per_day",
    "limits_invites_per_day", "limits_subscriptions_per_day", "active_hours",
    "flood_wait_threshold_min", "emergency_stop_ban_ratio",
    "emergency_stop_delete_ratio", "ai_monthly_limit_usd",
    "ai_spent_this_month_usd", "telegram_app_id", "telegram_app_hash",
    "anthropic_api_key", "notify_on_emergency_stop", "notify_on_spam_block",
}

# UI alias → real column.
_ALIAS_TO_COL = {
    "ai_model": "ai_default_model",
    "ai_monthly_budget": "ai_monthly_limit_usd",
    "daily_dm_limit": "limits_dm_per_day",
    "daily_chat_limit": "limits_chat_posts_per_day",
    "daily_comment_limit": "limits_comments_per_day",
    "daily_invite_limit": "limits_invites_per_day",
    "daily_join_limit": "limits_subscriptions_per_day",
    "flood_wait_threshold": "flood_wait_threshold_min",
    "emergency_ban_ratio": "emergency_stop_ban_ratio",
    "emergency_spam_ratio": "emergency_stop_delete_ratio",
    "app_id": "telegram_app_id",
    "app_hash": "telegram_app_hash",
    "notif_emergency_stop": "notify_on_emergency_stop",
    "notif_spam_block": "notify_on_spam_block",
}
# Reverse map (column → UI alias) for echoing UI-friendly names on GET.
_COL_TO_ALIAS = {v: k for k, v in _ALIAS_TO_COL.items()}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Secret fields are never returned in clear text — the GET response masks them
# (e.g. ``sk-a…AB12``). PATCH echoes the row too, so a client that reads back a
# masked value and re-submits it must NOT overwrite the real secret — see
# ``_strip_masked_secrets``.
_SECRET_FIELDS = ("anthropic_api_key", "telegram_app_hash")
# Incoming aliases that are also secrets (their masked round-trip must be dropped).
_SECRET_INCOMING = ("anthropic_api_key", "telegram_app_hash", "app_hash")
_MASK_CHAR = "…"


def _parse_active_hours(s: Any) -> tuple[int | None, int | None]:
    """``"09:00-22:00"`` → ``(9, 22)``. Returns (None, None) if unparseable."""
    if not s or not isinstance(s, str) or "-" not in s:
        return None, None
    try:
        start, end = s.split("-", 1)
        return int(start.split(":")[0]), int(end.split(":")[0])
    except (ValueError, IndexError):
        return None, None


def _compose_active_hours(start: Any, end: Any) -> str:
    """``(9, 22)`` → ``"09:00-22:00"``."""
    try:
        h1 = int(start) % 24
        h2 = int(end) % 24
    except (ValueError, TypeError):
        h1, h2 = 9, 22
    return f"{h1:02d}:00-{h2:02d}:00"


def _mask_secret(value: Any) -> Any:
    """Return a masked form of a secret that reveals only head/tail."""
    if not value:
        return value
    s = str(value)
    if len(s) <= 8:
        return "••••"
    return f"{s[:4]}{_MASK_CHAR}{s[-4:]}"


def _is_masked(val: Any) -> bool:
    return val is None or val == "" or (isinstance(val, str) and _MASK_CHAR in val)


def _row_to_settings(row: dict[str, Any]) -> dict[str, Any]:
    """Build the GET response: real columns (secrets masked, JSON parsed) + UI
    aliases + ``active_hours_start/end`` + spread ``extra_settings``."""
    data = dict(row)

    # ai_model_roles JSON
    if data.get("ai_model_roles"):
        try:
            data["ai_model_roles"] = json.loads(data["ai_model_roles"])
        except (json.JSONDecodeError, TypeError):
            data["ai_model_roles"] = {}
    else:
        data["ai_model_roles"] = {}

    # Spread extra_settings (UI-only fields) into the top level, then drop the raw column.
    extra_raw = data.pop("extra_settings", None)
    if extra_raw:
        try:
            extra = json.loads(extra_raw)
            if isinstance(extra, dict):
                data.update(extra)
        except (json.JSONDecodeError, TypeError):
            pass

    # Mask secrets in both canonical and alias names.
    for field in _SECRET_FIELDS:
        if data.get(field):
            data[field] = _mask_secret(data[field])

    # Echo UI aliases alongside canonical columns.
    for col, alias in _COL_TO_ALIAS.items():
        if col in data:
            data[alias] = data[col]

    # Decompose active_hours → start/end for the form.
    ah_start, ah_end = _parse_active_hours(row["active_hours"] if "active_hours" in row.keys() else None)
    if ah_start is not None:
        data["active_hours_start"] = ah_start
        data["active_hours_end"] = ah_end

    return data


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def get_settings(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return the singleton tg_settings row for this workspace."""
    row = db.execute(
        "SELECT * FROM tg_settings WHERE id = 'default'"
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Settings row not found")
    return _row_to_settings(row)


@router.patch("")
async def update_settings(
    body: dict[str, Any],
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update settings. Accepts both canonical column names and UI aliases.

    UI aliases are mapped to columns; ``active_hours_start/end`` are composed
    into ``active_hours``; any other unknown key is persisted into the
    ``extra_settings`` JSON blob (so the form never silently drops a field).
    Masked secret values echoed back from a prior GET are ignored.
    """
    row = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Settings row not found")

    col_updates: dict[str, Any] = {}
    extra_updates: dict[str, Any] = {}

    incoming = dict(body)

    # active_hours composition (needs both halves; fill the missing one from current).
    if "active_hours_start" in incoming or "active_hours_end" in incoming:
        cur_s, cur_e = _parse_active_hours(row["active_hours"])
        start = incoming.pop("active_hours_start", cur_s if cur_s is not None else 9)
        end = incoming.pop("active_hours_end", cur_e if cur_e is not None else 22)
        col_updates["active_hours"] = _compose_active_hours(start, end)

    for key, value in incoming.items():
        # Drop masked/echoed secrets (both alias and canonical names).
        if key in _SECRET_INCOMING and _is_masked(value):
            continue
        col = _ALIAS_TO_COL.get(key, key)
        if col in _REAL_COLUMNS:
            if col == "ai_model_roles" and value is not None:
                col_updates[col] = json.dumps(value)
            else:
                col_updates[col] = value
        else:
            extra_updates[key] = value

    if extra_updates:
        try:
            existing_extra = json.loads(row["extra_settings"]) if row["extra_settings"] else {}
            if not isinstance(existing_extra, dict):
                existing_extra = {}
        except (json.JSONDecodeError, TypeError):
            existing_extra = {}
        existing_extra.update(extra_updates)
        col_updates["extra_settings"] = json.dumps(existing_extra, ensure_ascii=False)

    if not col_updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    col_updates["updated_at"] = _now()
    set_clause = ", ".join(f"{k} = ?" for k in col_updates)
    values = list(col_updates.values())

    try:
        db.execute(
            f"UPDATE tg_settings SET {set_clause} WHERE id = 'default'", values
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    return _row_to_settings(row)
