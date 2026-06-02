"""Auto-Replier — scenario-based automatic reply engine for incoming DMs."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/auto-replier", tags=["auto-replier"])

log = structlog.get_logger(__name__)

VALID_BEHAVIORS = {"AI_REPLY", "TEMPLATE", "SILENCE", "NOTIFY", "HANDOFF_SALES"}
VALID_STATUSES = {"DRAFT", "ACTIVE", "PAUSED"}

_JSON_COLS = ("account_ids", "triggers")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ScenarioCreate(BaseModel):
    name: str
    account_ids: list[str] = Field(default_factory=list)
    triggers: list[dict[str, Any]] = Field(default_factory=list)
    default_behavior: str = "AI_REPLY"
    active_hours: str = "09:00-22:00"
    delay_min: int = 5
    delay_max: int = 45


class ScenarioUpdate(BaseModel):
    name: str | None = None
    account_ids: list[str] | None = None
    triggers: list[dict[str, Any]] | None = None
    default_behavior: str | None = None
    active_hours: str | None = None
    delay_min: int | None = None
    delay_max: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_scenario(row: dict[str, Any]) -> dict[str, Any]:
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


def _row_to_reply(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Scenarios CRUD
# ---------------------------------------------------------------------------

@router.get("/scenarios")
async def list_scenarios(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List auto-replier scenarios."""
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
        f"SELECT COUNT(*) AS total FROM tg_auto_replier_scenarios {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_auto_replier_scenarios {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_scenario(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/scenarios", status_code=status.HTTP_201_CREATED)
async def create_scenario(
    body: ScenarioCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new auto-replier scenario."""
    if body.default_behavior not in VALID_BEHAVIORS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid default_behavior '{body.default_behavior}'. Must be one of: {', '.join(sorted(VALID_BEHAVIORS))}",
        )

    now = _now()
    scenario_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_auto_replier_scenarios
                (id, name, account_ids, triggers, default_behavior,
                 active_hours, delay_min, delay_max, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                scenario_id, body.name,
                json.dumps(body.account_ids), json.dumps(body.triggers),
                body.default_behavior, body.active_hours,
                body.delay_min, body.delay_max, "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()

    log.info("scenario_created", scenario_id=scenario_id, name=body.name)
    return _row_to_scenario(row)


@router.patch("/scenarios/{scenario_id}")
async def update_scenario(
    scenario_id: str,
    body: ScenarioUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update an existing auto-replier scenario."""
    existing = db.execute(
        "SELECT id FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Scenario not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "default_behavior" in updates and updates["default_behavior"] not in VALID_BEHAVIORS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid default_behavior '{updates['default_behavior']}'.",
        )

    # Serialize JSON fields
    if "account_ids" in updates:
        updates["account_ids"] = json.dumps(updates["account_ids"])
    if "triggers" in updates:
        updates["triggers"] = json.dumps(updates["triggers"])

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [scenario_id]

    try:
        db.execute(
            f"UPDATE tg_auto_replier_scenarios SET {set_clause} WHERE id = ?", params
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()

    log.info("scenario_updated", scenario_id=scenario_id)
    return _row_to_scenario(row)


@router.delete("/scenarios/{scenario_id}")
async def delete_scenario(
    scenario_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete an auto-replier scenario by ID."""
    existing = db.execute(
        "SELECT id FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Scenario not found")

    try:
        db.execute("DELETE FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("scenario_deleted", scenario_id=scenario_id)
    return {"status": "deleted", "id": scenario_id}


@router.post("/scenarios/{scenario_id}/activate")
async def activate_scenario(
    scenario_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Start an auto-replier scenario and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Scenario not found")

    if row["status"] == "ACTIVE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Scenario is already active",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the scenario in its
    # prior status instead of falsely showing ACTIVE.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.auto_replier", args=[workspace_id, scenario_id])
    log.info("auto_replier_dispatched", scenario_id=scenario_id)

    try:
        db.execute(
            "UPDATE tg_auto_replier_scenarios SET status = ?, updated_at = ? WHERE id = ?",
            ["ACTIVE", now, scenario_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()

    log.info("scenario_activated", scenario_id=scenario_id)
    return _row_to_scenario(row)


@router.post("/scenarios/{scenario_id}/pause")
async def pause_scenario(
    scenario_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Pause an auto-replier scenario."""
    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Scenario not found")

    if row["status"] == "PAUSED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Scenario is already paused",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_auto_replier_scenarios SET status = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", now, scenario_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?", [scenario_id]
    ).fetchone()

    log.info("scenario_paused", scenario_id=scenario_id)
    return _row_to_scenario(row)


# ---------------------------------------------------------------------------
# Replies Log
# ---------------------------------------------------------------------------

@router.get("/log")
async def list_replies(
    _token: AdminAuth,
    db: WorkspaceDB,
    scenario_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List recent auto-replies log."""
    conditions: list[str] = []
    params: list[Any] = []

    if scenario_id:
        conditions.append("scenario_id = ?")
        params.append(scenario_id)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_auto_replies {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_auto_replies {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_reply(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}
