"""CRUD + control endpoints for format conversion tasks (TDATA/SESSION/SESSION_JSON)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/converter", tags=["converter"])

log = structlog.get_logger(__name__)

VALID_FORMATS = {"TDATA", "SESSION", "SESSION_JSON"}
VALID_STATUSES = {"DRAFT", "RUNNING", "COMPLETED", "FAILED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ConversionTaskCreate(BaseModel):
    name: str | None = None
    input_format: str
    output_format: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    if data.get("errors"):
        try:
            data["errors"] = json.loads(data["errors"])
        except (json.JSONDecodeError, TypeError):
            data["errors"] = []
    else:
        data["errors"] = []
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
    """List conversion tasks."""
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
        f"SELECT COUNT(*) AS total FROM tg_conversion_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_conversion_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: ConversionTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new conversion task."""
    if body.input_format not in VALID_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid input_format '{body.input_format}'. Must be one of: {', '.join(sorted(VALID_FORMATS))}",
        )

    if body.output_format not in VALID_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid output_format '{body.output_format}'. Must be one of: {', '.join(sorted(VALID_FORMATS))}",
        )

    if body.input_format == body.output_format:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="input_format and output_format must be different.",
        )

    now = _now()
    task_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_conversion_tasks
                (id, name, input_format, output_format, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, body.name, body.input_format, body.output_format,
                "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info(
        "conversion_task_created",
        task_id=task_id,
        input_format=body.input_format,
        output_format=body.output_format,
    )
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a conversion task."""
    existing = db.execute(
        "SELECT id FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Conversion task not found")

    try:
        db.execute("DELETE FROM tg_conversion_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("conversion_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set conversion task status to RUNNING."""
    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversion task not found")

    if row["status"] not in ("DRAFT",):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT.",
        )

    now = _now()
    try:
        db.execute(
            """UPDATE tg_conversion_tasks
               SET status = ?, started_at = ?, updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("conversion_task_started", task_id=task_id)
    return _row_to_dict(row)
