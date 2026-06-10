"""CRUD + control endpoints for boost tasks (subscribers, reactions, views, poll votes)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/boost", tags=["boost"])

log = structlog.get_logger(__name__)

VALID_BOOST_TYPES = {"SUBSCRIBERS", "REACTIONS", "VIEWS", "POLL_VOTES"}
VALID_STATUSES = {"DRAFT", "RUNNING", "PAUSED", "COMPLETED", "STOPPED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class BoostTaskCreate(BaseModel):
    name: str
    boost_type: str
    target_channel: str | None = None
    target_message_id: int | None = None
    target_amount: int = 0
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
    boost_type: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List boost tasks with optional filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if boost_type:
        if boost_type not in VALID_BOOST_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid boost_type '{boost_type}'. Must be one of: {', '.join(sorted(VALID_BOOST_TYPES))}",
            )
        conditions.append("boost_type = ?")
        params.append(boost_type)

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
        f"SELECT COUNT(*) AS total FROM tg_boost_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_boost_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def boost_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return aggregate stats by boost type."""
    rows = db.execute("""
        SELECT
            boost_type,
            COUNT(*) AS total_tasks,
            COALESCE(SUM(target_amount), 0) AS total_target,
            COALESCE(SUM(current_amount), 0) AS total_current
        FROM tg_boost_tasks
        GROUP BY boost_type
    """).fetchall()

    by_type = {}
    for r in rows:
        by_type[r["boost_type"]] = {
            "total_tasks": r["total_tasks"],
            "total_target": r["total_target"],
            "total_current": r["total_current"],
        }

    total_actions = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_boost_actions"
    ).fetchone()
    success_actions = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_boost_actions WHERE success = 1"
    ).fetchone()

    return {
        "by_type": by_type,
        "total_actions": total_actions["cnt"] if total_actions else 0,
        "success_actions": success_actions["cnt"] if success_actions else 0,
    }


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single boost task with action log count."""
    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Boost task not found")

    data = _row_to_dict(row)

    action_count = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_boost_actions WHERE task_id = ?", [task_id]
    ).fetchone()
    data["action_count"] = action_count["cnt"] if action_count else 0

    success_count = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_boost_actions WHERE task_id = ? AND success = 1",
        [task_id],
    ).fetchone()
    data["success_count"] = success_count["cnt"] if success_count else 0

    return data


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: BoostTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new boost task."""
    if body.boost_type not in VALID_BOOST_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid boost_type '{body.boost_type}'. Must be one of: {', '.join(sorted(VALID_BOOST_TYPES))}",
        )

    now = _now()
    task_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_boost_tasks
                (id, name, boost_type, target_channel, target_message_id,
                 config, target_amount, account_ids, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.boost_type, body.target_channel,
                body.target_message_id, json.dumps(body.config),
                body.target_amount, json.dumps(body.account_ids),
                "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("boost_task_created", task_id=task_id, boost_type=body.boost_type)
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a boost task and its action log (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Boost task not found")

    try:
        db.execute("DELETE FROM tg_boost_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("boost_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set boost task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Boost task not found")

    if row["status"] not in ("DRAFT", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT or PAUSED.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the task in its prior
    # status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.boost_task", args=[workspace_id, task_id])

    try:
        db.execute(
            """UPDATE tg_boost_tasks
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("boost_task_started", task_id=task_id)
    return _row_to_dict(row)


@router.post("/tasks/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set boost task status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Boost task not found")

    terminal = {"COMPLETED", "STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_boost_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("boost_task_stopped", task_id=task_id)
    return _row_to_dict(row)
