"""CRUD + control endpoints for stories boost tasks."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/stories-boost", tags=["stories-boost"])

log = structlog.get_logger(__name__)

VALID_MODES = {"AUTO_MONITOR", "MANUAL"}
VALID_STATUSES = {"DRAFT", "RUNNING", "PAUSED", "COMPLETED", "STOPPED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class StoriesBoostCreate(BaseModel):
    name: str
    mode: str = "MANUAL"
    target_channel: str | None = None
    target_story_id: int | None = None
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
    for field in ("config", "account_ids"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = {} if field == "config" else []
        else:
            data[field] = {} if field == "config" else []
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
    """List stories boost tasks."""
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
        f"SELECT COUNT(*) AS total FROM tg_stories_boost_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_stories_boost_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: StoriesBoostCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new stories boost task."""
    if body.mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{body.mode}'. Must be one of: {', '.join(sorted(VALID_MODES))}",
        )

    now = _now()
    task_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_stories_boost_tasks
                (id, name, mode, target_channel, target_story_id,
                 config, account_ids, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.mode, body.target_channel,
                body.target_story_id, json.dumps(body.config),
                json.dumps(body.account_ids), "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("stories_boost_created", task_id=task_id, mode=body.mode)
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a stories boost task."""
    existing = db.execute(
        "SELECT id FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Stories boost task not found")

    try:
        db.execute("DELETE FROM tg_stories_boost_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("stories_boost_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set stories boost task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Stories boost task not found")

    if row["status"] not in ("DRAFT", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT or PAUSED.",
        )

    now = _now()
    try:
        db.execute(
            """UPDATE tg_stories_boost_tasks
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Dispatch Celery stories boost task
    try:
        from app.tasks.celery_app import celery_app
        celery_app.send_task(
            "pup_tg.stories_boost",
            args=[workspace_id, task_id],
            queue="pup_tg_default",
        )
    except Exception as exc:
        log.warning("celery_dispatch_skipped", task_id=task_id, error=str(exc))

    row = db.execute(
        "SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("stories_boost_started", task_id=task_id)
    return _row_to_dict(row)


@router.post("/tasks/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set stories boost task status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Stories boost task not found")

    terminal = {"COMPLETED", "STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_stories_boost_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("stories_boost_stopped", task_id=task_id)
    return _row_to_dict(row)
