"""CRUD + control endpoints for Telegram parsing tasks."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/parser", tags=["parser"])

log = structlog.get_logger(__name__)

VALID_MODES = {
    "CHAT_MEMBERS",
    "COMMENTERS",
    "WRITERS",
    "REACTIONS",
    "POLLS",
    "JOINERS",
    "TOPICS",
    "GLOBAL_SEARCH",
}

VALID_STATUSES = {"PENDING", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ParsingTaskConfig(BaseModel):
    sources: list[str] = Field(default_factory=list)
    filters: dict[str, Any] = Field(default_factory=dict)
    threads: int = 3
    save_to_audience: str = "new"  # "new" or existing audience_id
    audience_name: str | None = None


class ParsingTaskCreate(BaseModel):
    name: str
    mode: str
    config: ParsingTaskConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_task(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    if data.get("config"):
        try:
            data["config"] = json.loads(data["config"])
        except (json.JSONDecodeError, TypeError):
            data["config"] = {}
    else:
        data["config"] = {}
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
    """List parsing tasks with optional status filter and pagination."""
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
        f"SELECT COUNT(*) AS total FROM tg_parsing_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_parsing_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_task(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single parsing task by ID with progress info."""
    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parsing task not found")
    return _row_to_task(row)


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: ParsingTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new parsing task. Optionally creates an audience for output."""
    if body.mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{body.mode}'. Must be one of: {', '.join(sorted(VALID_MODES))}",
        )

    now = _now()
    task_id = str(uuid.uuid4())
    audience_id: str | None = None

    # Create audience if save_to_audience == "new"
    if body.config.save_to_audience == "new":
        audience_id = str(uuid.uuid4())
        audience_name = body.config.audience_name or f"Аудитория: {body.name}"
        try:
            db.execute(
                """INSERT INTO tg_audiences (id, name, source_type, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                [audience_id, audience_name, "PARSED", now, now],
            )
        except Exception:
            db.rollback()
            raise
    elif body.config.save_to_audience != "new":
        # Verify the audience exists
        target_id = body.config.save_to_audience
        if target_id and target_id != "none":
            existing = db.execute(
                "SELECT id FROM tg_audiences WHERE id = ?", [target_id]
            ).fetchone()
            if not existing:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Audience '{target_id}' not found",
                )
            audience_id = target_id

    config_json = json.dumps(body.config.model_dump())

    try:
        db.execute(
            """INSERT INTO tg_parsing_tasks
                (id, name, mode, config, status, audience_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [task_id, body.name, body.mode, config_json, "PENDING", audience_id, now, now],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("parsing_task_created", task_id=task_id, mode=body.mode, audience_id=audience_id)
    return _row_to_task(row)


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parsing task not found")

    current_status = row["status"]
    if current_status not in ("PENDING", "PAUSED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{current_status}'. Must be PENDING or PAUSED.",
        )

    now = _now()

    # Dispatch first: if the engine is down this raises 503 and the task stays
    # in its current (PENDING/PAUSED) status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    celery_task_id = dispatch_task("pup_tg.parse_audience", args=[workspace_id, task_id])

    try:
        db.execute(
            """UPDATE tg_parsing_tasks
               SET status = ?, started_at = ?, celery_task_id = ?, updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, celery_task_id, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("parsing_task_started", task_id=task_id, celery_task_id=celery_task_id)
    return _row_to_task(row)


@router.post("/tasks/{task_id}/pause")
async def pause_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set task status to PAUSED."""
    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parsing task not found")

    if row["status"] != "RUNNING":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot pause task in status '{row['status']}'. Must be RUNNING.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_parsing_tasks SET status = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("parsing_task_paused", task_id=task_id)
    return _row_to_task(row)


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set task status to CANCELLED."""
    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parsing task not found")

    terminal = {"COMPLETED", "FAILED", "CANCELLED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot cancel task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_parsing_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["CANCELLED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Attempt to revoke Celery task
    if row["celery_task_id"]:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(row["celery_task_id"], terminate=True)
        except Exception as exc:
            log.warning("celery_revoke_failed", task_id=task_id, error=str(exc))

    row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("parsing_task_cancelled", task_id=task_id)
    return _row_to_task(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a parsing task by ID."""
    existing = db.execute(
        "SELECT id, status, celery_task_id FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Parsing task not found")

    # Revoke if still running
    if existing["status"] == "RUNNING" and existing["celery_task_id"]:
        try:
            from app.tasks.celery_app import celery_app
            celery_app.control.revoke(existing["celery_task_id"], terminate=True)
        except Exception as exc:
            log.warning("celery_revoke_failed", task_id=task_id, error=str(exc))

    try:
        db.execute("DELETE FROM tg_parsing_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("parsing_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}
