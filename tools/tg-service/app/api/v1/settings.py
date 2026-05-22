"""Singleton settings endpoint for TG Service workspace configuration."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SettingsUpdate(BaseModel):
    ai_default_model: str | None = None
    ai_model_roles: dict[str, str] | None = None
    limits_dm_per_day: int | None = None
    limits_chat_posts_per_day: int | None = None
    limits_comments_per_day: int | None = None
    limits_invites_per_day: int | None = None
    limits_subscriptions_per_day: int | None = None
    active_hours: str | None = None
    flood_wait_threshold_min: int | None = None
    emergency_stop_ban_ratio: float | None = None
    emergency_stop_delete_ratio: float | None = None
    ai_monthly_limit_usd: float | None = None
    ai_spent_this_month_usd: float | None = None
    telegram_app_id: int | None = None
    telegram_app_hash: str | None = None
    anthropic_api_key: str | None = None
    proxy_seller_api_key: str | None = None
    notify_on_emergency_stop: int | None = None
    notify_on_spam_block: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_settings(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict, deserializing JSON columns."""
    data = dict(row)
    if data.get("ai_model_roles"):
        try:
            data["ai_model_roles"] = json.loads(data["ai_model_roles"])
        except (json.JSONDecodeError, TypeError):
            data["ai_model_roles"] = {}
    else:
        data["ai_model_roles"] = {}
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
    body: SettingsUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update settings fields. Only provided (non-None) fields are updated."""
    updates: dict[str, Any] = {}
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "ai_model_roles" and value is not None:
            updates["ai_model_roles"] = json.dumps(value)
        else:
            updates[field] = value

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values())

    try:
        db.execute(
            f"UPDATE tg_settings SET {set_clause} WHERE id = 'default'", values
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_settings WHERE id = 'default'"
    ).fetchone()
    return _row_to_settings(row)
