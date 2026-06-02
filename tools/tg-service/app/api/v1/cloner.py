"""CRUD + control endpoints for channel cloner tasks."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/cloner", tags=["cloner"])

log = structlog.get_logger(__name__)

VALID_STATUSES = {"DRAFT", "RUNNING", "PAUSED", "COMPLETED", "STOPPED"}
VALID_COPY_ITEMS = {"posts", "profile", "avatar", "pinned"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ClonerTaskCreate(BaseModel):
    name: str
    source_channel: str
    target_channel: str
    copy_items: list[str] = Field(default_factory=lambda: ["posts"])
    ai_rewrite: bool = False
    ai_rewrite_style: str | None = None
    schedule_config: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    for field in ("copy_items", "schedule_config"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = ["posts"] if field == "copy_items" else {}
        else:
            data[field] = ["posts"] if field == "copy_items" else {}
    # Convert integer boolean back to bool
    if "ai_rewrite" in data:
        data["ai_rewrite"] = bool(data["ai_rewrite"])
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
    """List cloner tasks."""
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
        f"SELECT COUNT(*) AS total FROM tg_clone_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_clone_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: ClonerTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new cloner task."""
    # Validate copy_items
    invalid_items = set(body.copy_items) - VALID_COPY_ITEMS
    if invalid_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid copy_items: {', '.join(sorted(invalid_items))}. Must be from: {', '.join(sorted(VALID_COPY_ITEMS))}",
        )

    now = _now()
    task_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_clone_tasks
                (id, name, source_channel, target_channel, copy_items,
                 ai_rewrite, ai_rewrite_style, schedule_config,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.source_channel, body.target_channel,
                json.dumps(body.copy_items), int(body.ai_rewrite),
                body.ai_rewrite_style, json.dumps(body.schedule_config),
                "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("cloner_task_created", task_id=task_id, source=body.source_channel)
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a cloner task."""
    existing = db.execute(
        "SELECT id FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Cloner task not found")

    try:
        db.execute("DELETE FROM tg_clone_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("cloner_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set cloner task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Cloner task not found")

    if row["status"] not in ("DRAFT", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT or PAUSED.",
        )

    now = _now()
    # Dispatch first: a down engine raises 503 and leaves the task in its prior
    # status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.cloner_task", args=[workspace_id, task_id])

    try:
        db.execute(
            """UPDATE tg_clone_tasks
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("cloner_task_started", task_id=task_id)
    return _row_to_dict(row)


@router.post("/tasks/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set cloner task status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Cloner task not found")

    terminal = {"COMPLETED", "STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_clone_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("cloner_task_stopped", task_id=task_id)
    return _row_to_dict(row)
