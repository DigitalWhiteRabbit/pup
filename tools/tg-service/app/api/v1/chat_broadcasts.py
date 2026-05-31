"""CRUD + control endpoints for chat broadcast campaigns."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/chat-broadcasts", tags=["chat-broadcasts"])

log = structlog.get_logger(__name__)

VALID_STATUSES = {
    "DRAFT", "SCHEDULED", "RUNNING", "PAUSED",
    "COMPLETED", "STOPPED", "EMERGENCY_STOPPED",
}

POST_STATUSES = {
    "PENDING", "POSTED", "DELETED_BY_MODS",
    "BANNED_IN_CHAT", "FAILED", "SLOW_MODE",
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class BroadcastCreate(BaseModel):
    name: str
    template_id: str | None = None
    target_channels: list[str] = Field(default_factory=list)
    account_ids: list[str] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    for field in ("config", "account_ids", "target_channels"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = {} if field == "config" else []
        else:
            data[field] = {} if field == "config" else []
    return data


def _row_to_post(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a broadcast post row to dict."""
    return dict(row)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_broadcasts(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List chat broadcast campaigns with optional status filter."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        if status_filter not in VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_chat_broadcasts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_chat_broadcasts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def broadcast_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return aggregate stats across all chat broadcasts."""
    row = db.execute("""
        SELECT
            COUNT(*) AS total_campaigns,
            COALESCE(SUM(posted_count), 0) AS total_posted,
            COALESCE(SUM(deleted_count), 0) AS total_deleted,
            COALESCE(SUM(banned_count), 0) AS total_banned
        FROM tg_chat_broadcasts
    """).fetchone()

    total_posted = row["total_posted"] if row else 0
    total_deleted = row["total_deleted"] if row else 0
    survival_rate = round((total_posted - total_deleted) / total_posted * 100, 2) if total_posted > 0 else 0.0

    return {
        "total_campaigns": row["total_campaigns"] if row else 0,
        "total_posted": total_posted,
        "total_deleted": total_deleted,
        "total_banned": row["total_banned"] if row else 0,
        "survival_rate": survival_rate,
    }


@router.get("/{broadcast_id}")
async def get_broadcast(
    broadcast_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single chat broadcast with post stats."""
    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat broadcast not found")

    data = _row_to_dict(row)

    # Attach post stats breakdown
    post_stats = db.execute("""
        SELECT status, COUNT(*) AS cnt
        FROM tg_chat_broadcast_posts
        WHERE broadcast_id = ?
        GROUP BY status
    """, [broadcast_id]).fetchall()

    data["post_stats"] = {r["status"]: r["cnt"] for r in post_stats}
    return data


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_broadcast(
    body: BroadcastCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new chat broadcast campaign."""
    now = _now()
    broadcast_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_chat_broadcasts
                (id, name, template_id, target_channels, account_ids, config,
                 status, total_targets, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                broadcast_id, body.name, body.template_id,
                json.dumps(body.target_channels), json.dumps(body.account_ids),
                json.dumps(body.config), "DRAFT",
                len(body.target_channels), now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()

    log.info("chat_broadcast_created", broadcast_id=broadcast_id, name=body.name)
    return _row_to_dict(row)


@router.delete("/{broadcast_id}")
async def delete_broadcast(
    broadcast_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a chat broadcast and its posts (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Chat broadcast not found")

    try:
        db.execute("DELETE FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("chat_broadcast_deleted", broadcast_id=broadcast_id)
    return {"status": "deleted", "id": broadcast_id}


@router.post("/{broadcast_id}/start")
async def start_broadcast(
    broadcast_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set broadcast status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat broadcast not found")

    if row["status"] not in ("DRAFT", "PAUSED", "SCHEDULED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start broadcast in status '{row['status']}'. Must be DRAFT, PAUSED, or SCHEDULED.",
        )

    now = _now()
    try:
        db.execute(
            """UPDATE tg_chat_broadcasts
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, broadcast_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Dispatch Celery chat broadcast task
    try:
        from app.tasks.celery_app import celery_app
        celery_app.send_task(
            "pup_tg.chat_broadcast",
            args=[workspace_id, broadcast_id],
            queue="pup_tg_default",
        )
    except Exception as exc:
        log.warning("celery_dispatch_skipped", broadcast_id=broadcast_id, error=str(exc))

    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()

    log.info("chat_broadcast_started", broadcast_id=broadcast_id)
    return _row_to_dict(row)


@router.post("/{broadcast_id}/stop")
async def stop_broadcast(
    broadcast_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set broadcast status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat broadcast not found")

    terminal = {"COMPLETED", "STOPPED", "EMERGENCY_STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop broadcast in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_chat_broadcasts SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, broadcast_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()

    log.info("chat_broadcast_stopped", broadcast_id=broadcast_id)
    return _row_to_dict(row)


@router.get("/{broadcast_id}/posts")
async def list_posts(
    broadcast_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List posts for a specific chat broadcast."""
    # Verify broadcast exists
    existing = db.execute(
        "SELECT id FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Chat broadcast not found")

    conditions: list[str] = ["broadcast_id = ?"]
    params: list[Any] = [broadcast_id]

    if status_filter:
        if status_filter not in POST_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(POST_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}"

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_chat_broadcast_posts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_chat_broadcast_posts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_post(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}
