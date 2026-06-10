"""CRUD + control endpoints for channel creation tasks."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/channel-creator", tags=["channel-creator"])

log = structlog.get_logger(__name__)

VALID_CHANNEL_TYPES = {"CHANNEL", "SUPERGROUP", "BASIC_GROUP"}
VALID_STATUSES = {"DRAFT", "RUNNING", "PAUSED", "COMPLETED", "STOPPED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ChannelCreatorCreate(BaseModel):
    name: str
    channel_type: str = "CHANNEL"
    count: int = 1
    naming_pattern: str | None = None
    username_pattern: str | None = None
    description: str | None = None
    creator_account_ids: list[str] = Field(default_factory=list)
    # The UI sends `account_ids`; accept it as an alias so the operator's
    # account selection isn't silently dropped (P2-09).
    account_ids: list[str] | None = None
    permissions: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    for field in ("creator_account_ids", "created_channel_ids"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = []
        else:
            data[field] = []
    if data.get("permissions"):
        try:
            data["permissions"] = json.loads(data["permissions"])
        except (json.JSONDecodeError, TypeError):
            data["permissions"] = {}
    else:
        data["permissions"] = {}
    return data


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/tasks")
async def list_tasks(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List channel creation tasks."""
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
        f"SELECT COUNT(*) AS total FROM tg_channel_creation_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_channel_creation_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: ChannelCreatorCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new channel creation task."""
    if body.channel_type not in VALID_CHANNEL_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid channel_type '{body.channel_type}'. Must be one of: {', '.join(sorted(VALID_CHANNEL_TYPES))}",
        )

    if body.count < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Count must be at least 1.",
        )

    now = _now()
    task_id = str(uuid.uuid4())
    # Prefer the explicit field; fall back to the UI's `account_ids` alias.
    creator_ids = body.creator_account_ids or body.account_ids or []

    try:
        db.execute(
            """INSERT INTO tg_channel_creation_tasks
                (id, name, channel_type, count, naming_pattern, username_pattern,
                 description, creator_account_ids, permissions,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.channel_type, body.count,
                body.naming_pattern, body.username_pattern,
                body.description, json.dumps(creator_ids),
                json.dumps(body.permissions), "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("channel_creator_task_created", task_id=task_id, channel_type=body.channel_type)
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a channel creation task."""
    existing = db.execute(
        "SELECT id FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Channel creation task not found")

    try:
        db.execute("DELETE FROM tg_channel_creation_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("channel_creator_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set channel creation task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Channel creation task not found")

    if row["status"] not in ("DRAFT", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT or PAUSED.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the task in its prior
    # status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.channel_creator", args=[workspace_id, task_id])

    try:
        db.execute(
            """UPDATE tg_channel_creation_tasks
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("channel_creator_task_started", task_id=task_id)
    return _row_to_dict(row)


@router.post("/tasks/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set channel creation task status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Channel creation task not found")

    terminal = {"COMPLETED", "STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            """UPDATE tg_channel_creation_tasks
               SET status = ?, finished_at = ?, updated_at = ?
               WHERE id = ?""",
            ["STOPPED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("channel_creator_task_stopped", task_id=task_id)
    return _row_to_dict(row)
