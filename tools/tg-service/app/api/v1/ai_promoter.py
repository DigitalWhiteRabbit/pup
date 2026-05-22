"""AI Promoter — personas & message queue for autonomous chat posting."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/ai-promoter", tags=["ai-promoter"])

log = structlog.get_logger(__name__)

VALID_STRATEGIES = {"soft", "medium", "aggressive"}
VALID_PERSONA_STATUSES = {"DRAFT", "ACTIVE", "PAUSED"}
VALID_MSG_STATUSES = {"PENDING", "APPROVED", "SENT", "REJECTED", "FAILED"}

# JSON column names that need loads/dumps
_PERSONA_JSON_COLS = ("target_channels", "schedule")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PersonaCreate(BaseModel):
    name: str
    account_id: str | None = None
    niche: str | None = None
    bio: str | None = None
    personality: str | None = None
    strategy: str = "soft"
    system_prompt: str = ""
    ai_model: str = "claude-haiku-4-5"
    temperature: float = 0.8
    target_channels: list[str] = Field(default_factory=list)
    schedule: dict[str, Any] = Field(default_factory=dict)


class PersonaUpdate(BaseModel):
    name: str | None = None
    account_id: str | None = None
    niche: str | None = None
    bio: str | None = None
    personality: str | None = None
    strategy: str | None = None
    system_prompt: str | None = None
    ai_model: str | None = None
    temperature: float | None = None
    target_channels: list[str] | None = None
    schedule: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_persona(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    for col in _PERSONA_JSON_COLS:
        if data.get(col):
            try:
                data[col] = json.loads(data[col])
            except (json.JSONDecodeError, TypeError):
                data[col] = [] if col == "target_channels" else {}
        else:
            data[col] = [] if col == "target_channels" else {}
    return data


def _row_to_message(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Persona CRUD
# ---------------------------------------------------------------------------

@router.get("/personas")
async def list_personas(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List AI promoter personas."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        if status_filter not in VALID_PERSONA_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_PERSONA_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_ai_personas {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_ai_personas {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_persona(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/personas/{persona_id}")
async def get_persona(
    persona_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single AI persona by ID."""
    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Persona not found")
    return _row_to_persona(row)


@router.post("/personas", status_code=status.HTTP_201_CREATED)
async def create_persona(
    body: PersonaCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new AI promoter persona."""
    if body.strategy not in VALID_STRATEGIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid strategy '{body.strategy}'. Must be one of: {', '.join(sorted(VALID_STRATEGIES))}",
        )

    now = _now()
    persona_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_ai_personas
                (id, name, account_id, niche, bio, personality, strategy,
                 system_prompt, ai_model, temperature, target_channels, schedule,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                persona_id, body.name, body.account_id, body.niche, body.bio,
                body.personality, body.strategy, body.system_prompt, body.ai_model,
                body.temperature, json.dumps(body.target_channels),
                json.dumps(body.schedule), "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()

    log.info("persona_created", persona_id=persona_id, name=body.name)
    return _row_to_persona(row)


@router.patch("/personas/{persona_id}")
async def update_persona(
    persona_id: str,
    body: PersonaUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update an existing AI persona."""
    existing = db.execute(
        "SELECT id FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Persona not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "strategy" in updates and updates["strategy"] not in VALID_STRATEGIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid strategy '{updates['strategy']}'.",
        )

    # Serialize JSON fields
    if "target_channels" in updates:
        updates["target_channels"] = json.dumps(updates["target_channels"])
    if "schedule" in updates:
        updates["schedule"] = json.dumps(updates["schedule"])

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [persona_id]

    try:
        db.execute(
            f"UPDATE tg_ai_personas SET {set_clause} WHERE id = ?", params
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()

    log.info("persona_updated", persona_id=persona_id)
    return _row_to_persona(row)


@router.delete("/personas/{persona_id}")
async def delete_persona(
    persona_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete an AI persona by ID."""
    existing = db.execute(
        "SELECT id FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Persona not found")

    try:
        db.execute("DELETE FROM tg_ai_personas WHERE id = ?", [persona_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("persona_deleted", persona_id=persona_id)
    return {"status": "deleted", "id": persona_id}


@router.post("/personas/{persona_id}/activate")
async def activate_persona(
    persona_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set persona status to ACTIVE."""
    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Persona not found")

    if row["status"] == "ACTIVE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Persona is already active",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_ai_personas SET status = ?, updated_at = ? WHERE id = ?",
            ["ACTIVE", now, persona_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()

    log.info("persona_activated", persona_id=persona_id)
    return _row_to_persona(row)


@router.post("/personas/{persona_id}/pause")
async def pause_persona(
    persona_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set persona status to PAUSED."""
    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Persona not found")

    if row["status"] == "PAUSED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Persona is already paused",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_ai_personas SET status = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", now, persona_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()

    log.info("persona_paused", persona_id=persona_id)
    return _row_to_persona(row)


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

@router.get("/messages")
async def list_messages(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    persona_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List AI messages with filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        if status_filter not in VALID_MSG_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_MSG_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    if persona_id:
        conditions.append("persona_id = ?")
        params.append(persona_id)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_ai_messages {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_ai_messages {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_message(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/messages/{message_id}/approve")
async def approve_message(
    message_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Approve a pending AI message."""
    row = db.execute(
        "SELECT * FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")

    if row["status"] != "PENDING":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot approve message in status '{row['status']}'. Must be PENDING.",
        )

    try:
        db.execute(
            "UPDATE tg_ai_messages SET status = ? WHERE id = ?",
            ["APPROVED", message_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()

    log.info("message_approved", message_id=message_id)
    return _row_to_message(row)


@router.post("/messages/{message_id}/reject")
async def reject_message(
    message_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Reject a pending AI message."""
    row = db.execute(
        "SELECT * FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")

    if row["status"] != "PENDING":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot reject message in status '{row['status']}'. Must be PENDING.",
        )

    try:
        db.execute(
            "UPDATE tg_ai_messages SET status = ? WHERE id = ?",
            ["REJECTED", message_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()

    log.info("message_rejected", message_id=message_id)
    return _row_to_message(row)


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@router.get("/stats")
async def promoter_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Aggregate stats for AI promoter."""
    total_personas = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_personas"
    ).fetchone()["cnt"]

    active_personas = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_personas WHERE status = 'ACTIVE'"
    ).fetchone()["cnt"]

    messages_today = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_messages WHERE created_at >= date('now')"
    ).fetchone()["cnt"]

    total_leads = db.execute(
        "SELECT COALESCE(SUM(total_leads), 0) AS cnt FROM tg_ai_personas"
    ).fetchone()["cnt"]

    return {
        "total_personas": total_personas,
        "active_personas": active_personas,
        "messages_today": messages_today,
        "total_leads": total_leads,
    }
