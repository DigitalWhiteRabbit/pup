"""AI Sales — scripts, dialogs, and message tracking for automated DM sales."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/ai-sales", tags=["ai-sales"])

log = structlog.get_logger(__name__)

VALID_SCRIPT_STATUSES = {"DRAFT", "ACTIVE", "PAUSED"}
VALID_LEAD_STATUSES = {
    "NEW", "ENGAGING", "QUALIFIED", "PROPOSAL",
    "CONVERTED", "LOST", "HANDED_OFF",
}

_SCRIPT_JSON_COLS = ("stages", "rag_doc_ids")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ScriptCreate(BaseModel):
    name: str
    description: str | None = None
    stages: list[dict[str, Any]] = Field(default_factory=list)
    system_prompt: str = ""
    ai_model: str = "claude-sonnet-4-6"
    rag_enabled: bool = True
    rag_doc_ids: list[str] = Field(default_factory=list)


class ScriptUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    stages: list[dict[str, Any]] | None = None
    system_prompt: str | None = None
    ai_model: str | None = None
    rag_enabled: bool | None = None
    rag_doc_ids: list[str] | None = None
    status: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_script(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    for col in _SCRIPT_JSON_COLS:
        if data.get(col):
            try:
                data[col] = json.loads(data[col])
            except (json.JSONDecodeError, TypeError):
                data[col] = []
        else:
            data[col] = []
    return data


def _row_to_dialog(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


def _row_to_message(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Scripts CRUD
# ---------------------------------------------------------------------------

@router.get("/scripts")
async def list_scripts(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List sales scripts."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        if status_filter not in VALID_SCRIPT_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_SCRIPT_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_sales_scripts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_sales_scripts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_script(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/scripts", status_code=status.HTTP_201_CREATED)
async def create_script(
    body: ScriptCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new sales script."""
    now = _now()
    script_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_sales_scripts
                (id, name, description, stages, system_prompt, ai_model,
                 rag_enabled, rag_doc_ids, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                script_id, body.name, body.description,
                json.dumps(body.stages), body.system_prompt, body.ai_model,
                1 if body.rag_enabled else 0, json.dumps(body.rag_doc_ids),
                "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_sales_scripts WHERE id = ?", [script_id]
    ).fetchone()

    log.info("script_created", script_id=script_id, name=body.name)
    return _row_to_script(row)


@router.patch("/scripts/{script_id}")
async def update_script(
    script_id: str,
    body: ScriptUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update an existing sales script."""
    existing = db.execute(
        "SELECT id FROM tg_sales_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Script not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "status" in updates and updates["status"] not in VALID_SCRIPT_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status '{updates['status']}'.",
        )

    # Serialize JSON fields
    if "stages" in updates:
        updates["stages"] = json.dumps(updates["stages"])
    if "rag_doc_ids" in updates:
        updates["rag_doc_ids"] = json.dumps(updates["rag_doc_ids"])
    if "rag_enabled" in updates:
        updates["rag_enabled"] = 1 if updates["rag_enabled"] else 0

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [script_id]

    try:
        db.execute(
            f"UPDATE tg_sales_scripts SET {set_clause} WHERE id = ?", params
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_sales_scripts WHERE id = ?", [script_id]
    ).fetchone()

    log.info("script_updated", script_id=script_id)
    return _row_to_script(row)


@router.delete("/scripts/{script_id}")
async def delete_script(
    script_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a sales script by ID."""
    existing = db.execute(
        "SELECT id FROM tg_sales_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Script not found")

    try:
        db.execute("DELETE FROM tg_sales_scripts WHERE id = ?", [script_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("script_deleted", script_id=script_id)
    return {"status": "deleted", "id": script_id}


# ---------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------

@router.get("/dialogs")
async def list_dialogs(
    _token: AdminAuth,
    db: WorkspaceDB,
    lead_status: str | None = Query(None),
    script_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List sales dialogs with optional filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if lead_status:
        if lead_status not in VALID_LEAD_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid lead_status '{lead_status}'. Must be one of: {', '.join(sorted(VALID_LEAD_STATUSES))}",
            )
        conditions.append("lead_status = ?")
        params.append(lead_status)

    if script_id:
        conditions.append("script_id = ?")
        params.append(script_id)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_sales_dialogs {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_sales_dialogs {where} ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dialog(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/dialogs/{dialog_id}")
async def get_dialog(
    dialog_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single dialog with its messages."""
    row = db.execute(
        "SELECT * FROM tg_sales_dialogs WHERE id = ?", [dialog_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Dialog not found")

    messages = db.execute(
        "SELECT * FROM tg_sales_messages WHERE dialog_id = ? ORDER BY created_at ASC",
        [dialog_id],
    ).fetchall()

    dialog = _row_to_dialog(row)
    dialog["messages"] = [_row_to_message(m) for m in messages]
    return dialog


@router.post("/dialogs/{dialog_id}/handoff")
async def handoff_dialog(
    dialog_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Hand off a dialog to a human operator."""
    row = db.execute(
        "SELECT * FROM tg_sales_dialogs WHERE id = ?", [dialog_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Dialog not found")

    terminal = {"CONVERTED", "LOST", "HANDED_OFF"}
    if row["lead_status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot hand off dialog in status '{row['lead_status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_sales_dialogs SET lead_status = ?, updated_at = ? WHERE id = ?",
            ["HANDED_OFF", now, dialog_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_sales_dialogs WHERE id = ?", [dialog_id]
    ).fetchone()

    log.info("dialog_handed_off", dialog_id=dialog_id)
    return _row_to_dialog(row)


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@router.get("/stats")
async def sales_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Aggregate stats for AI sales."""
    total_dialogs = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_sales_dialogs"
    ).fetchone()["cnt"]

    by_status_rows = db.execute(
        "SELECT lead_status, COUNT(*) AS cnt FROM tg_sales_dialogs GROUP BY lead_status"
    ).fetchall()
    by_status = {r["lead_status"]: r["cnt"] for r in by_status_rows}

    converted = by_status.get("CONVERTED", 0)
    conversion_rate = (converted / total_dialogs * 100) if total_dialogs > 0 else 0.0

    total_scripts = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_sales_scripts"
    ).fetchone()["cnt"]

    active_scripts = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_sales_scripts WHERE status = 'ACTIVE'"
    ).fetchone()["cnt"]

    return {
        "total_dialogs": total_dialogs,
        "by_status": by_status,
        "conversion_rate": round(conversion_rate, 2),
        "total_scripts": total_scripts,
        "active_scripts": active_scripts,
    }
