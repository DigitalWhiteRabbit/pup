"""Commenting tasks — AI/template-based auto-commenting on target channels."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/commenting", tags=["commenting"])

log = structlog.get_logger(__name__)

VALID_MODES = {"AI", "TEMPLATES", "MIXED"}
VALID_TRIGGER_TYPES = {"ALL_POSTS", "KEYWORDS", "MANUAL"}
VALID_APPROVAL_MODES = {"AUTO", "ALL", "IMPORTANT"}
VALID_STATUSES = {"DRAFT", "ACTIVE", "PAUSED"}

_JSON_COLS = ("target_channels", "account_ids")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CommentingTaskCreate(BaseModel):
    name: str
    mode: str = "AI"
    target_channels: list[str] = Field(default_factory=list)
    account_ids: list[str] = Field(default_factory=list)
    trigger_type: str = "ALL_POSTS"
    trigger_keywords: str | None = None
    system_prompt: str = ""
    ai_model: str = "claude-haiku-4-5"
    approval_mode: str = "AUTO"
    max_per_day: int = 10
    delay_min: int = 60
    delay_max: int = 600


class CommentingTaskUpdate(BaseModel):
    name: str | None = None
    mode: str | None = None
    target_channels: list[str] | None = None
    account_ids: list[str] | None = None
    trigger_type: str | None = None
    trigger_keywords: str | None = None
    system_prompt: str | None = None
    ai_model: str | None = None
    approval_mode: str | None = None
    max_per_day: int | None = None
    delay_min: int | None = None
    delay_max: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_task(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    for col in _JSON_COLS:
        if data.get(col):
            try:
                data[col] = json.loads(data[col])
            except (json.JSONDecodeError, TypeError):
                data[col] = []
        else:
            data[col] = []
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
    """List commenting tasks."""
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
        f"SELECT COUNT(*) AS total FROM tg_commenting_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_commenting_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_task(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: CommentingTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new commenting task."""
    if body.mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{body.mode}'. Must be one of: {', '.join(sorted(VALID_MODES))}",
        )
    if body.trigger_type not in VALID_TRIGGER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid trigger_type '{body.trigger_type}'. Must be one of: {', '.join(sorted(VALID_TRIGGER_TYPES))}",
        )
    if body.approval_mode not in VALID_APPROVAL_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid approval_mode '{body.approval_mode}'. Must be one of: {', '.join(sorted(VALID_APPROVAL_MODES))}",
        )

    now = _now()
    task_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_commenting_tasks
                (id, name, mode, target_channels, account_ids, trigger_type,
                 trigger_keywords, system_prompt, ai_model, approval_mode,
                 max_per_day, delay_min, delay_max, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.mode,
                json.dumps(body.target_channels), json.dumps(body.account_ids),
                body.trigger_type, body.trigger_keywords, body.system_prompt,
                body.ai_model, body.approval_mode, body.max_per_day,
                body.delay_min, body.delay_max, "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("commenting_task_created", task_id=task_id, name=body.name)
    return _row_to_task(row)


@router.patch("/tasks/{task_id}")
async def update_task(
    task_id: str,
    body: CommentingTaskUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update an existing commenting task."""
    existing = db.execute(
        "SELECT id FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Commenting task not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "mode" in updates and updates["mode"] not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{updates['mode']}'.",
        )
    if "trigger_type" in updates and updates["trigger_type"] not in VALID_TRIGGER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid trigger_type '{updates['trigger_type']}'.",
        )
    if "approval_mode" in updates and updates["approval_mode"] not in VALID_APPROVAL_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid approval_mode '{updates['approval_mode']}'.",
        )

    # Serialize JSON fields
    if "target_channels" in updates:
        updates["target_channels"] = json.dumps(updates["target_channels"])
    if "account_ids" in updates:
        updates["account_ids"] = json.dumps(updates["account_ids"])

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [task_id]

    try:
        db.execute(
            f"UPDATE tg_commenting_tasks SET {set_clause} WHERE id = ?", params
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("commenting_task_updated", task_id=task_id)
    return _row_to_task(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a commenting task by ID."""
    existing = db.execute(
        "SELECT id FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Commenting task not found")

    try:
        db.execute("DELETE FROM tg_commenting_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("commenting_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Activate a commenting task and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Commenting task not found")

    if row["status"] not in ("DRAFT", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT or PAUSED.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the task in its prior
    # status (DRAFT/PAUSED) instead of falsely showing ACTIVE.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.commenting_task", args=[workspace_id, task_id])

    try:
        db.execute(
            "UPDATE tg_commenting_tasks SET status = ?, updated_at = ? WHERE id = ?",
            ["ACTIVE", now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("commenting_task_started", task_id=task_id)
    return _row_to_task(row)


@router.post("/tasks/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Pause a commenting task."""
    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Commenting task not found")

    if row["status"] != "ACTIVE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in status '{row['status']}'. Must be ACTIVE.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_commenting_tasks SET status = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("commenting_task_stopped", task_id=task_id)
    return _row_to_task(row)
