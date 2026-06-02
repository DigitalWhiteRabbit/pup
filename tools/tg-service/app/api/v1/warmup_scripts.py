"""CRUD + run endpoints for warmup scripts and runs."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/warmup-scripts", tags=["warmup-scripts"])

log = structlog.get_logger(__name__)

VALID_SCRIPT_STATUSES = {"ACTIVE", "ARCHIVED"}
VALID_RUN_STATUSES = {"PENDING", "RUNNING", "COMPLETED", "FAILED"}
VALID_ACTION_TYPES = {"subscribe", "react", "comment", "read_chats", "view_stories"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ActionItem(BaseModel):
    type: str
    count: int = 1
    channels: list[str] = Field(default_factory=list)
    emoji: str | None = None
    text: str | None = None


class ScriptCreate(BaseModel):
    name: str
    description: str | None = None
    actions: list[ActionItem] = Field(default_factory=list)
    target_channels: list[str] = Field(default_factory=list)


class ScriptUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    actions: list[ActionItem] | None = None
    target_channels: list[str] | None = None
    status: str | None = None


class RunScriptBody(BaseModel):
    account_ids: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Convert a raw SQLite row to an API-compatible dict."""
    data = dict(row)
    for field in ("actions", "target_channels"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = []
        else:
            data[field] = []
    return data


def _run_to_dict(row: Any) -> dict[str, Any]:
    """Convert a warmup run row to dict."""
    data = dict(row)
    for field in ("account_ids", "results"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = []
        else:
            data[field] = []
    return data


def _validate_actions(actions: list[ActionItem]) -> None:
    """Validate all action types are supported."""
    for action in actions:
        if action.type not in VALID_ACTION_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Invalid action type '{action.type}'. "
                    f"Must be one of: {', '.join(sorted(VALID_ACTION_TYPES))}"
                ),
            )
        if action.count < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Action count must be >= 1, got {action.count} for '{action.type}'",
            )


# ---------------------------------------------------------------------------
# Script CRUD
# ---------------------------------------------------------------------------

@router.post("/scripts", status_code=status.HTTP_201_CREATED)
async def create_script(
    body: ScriptCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a warmup script with a list of actions."""
    if body.actions:
        _validate_actions(body.actions)

    now = _now()
    script_id = str(uuid.uuid4())

    actions_json = json.dumps([a.model_dump() for a in body.actions])
    channels_json = json.dumps(body.target_channels)

    try:
        db.execute(
            """INSERT INTO tg_warmup_scripts
                (id, name, description, actions, target_channels, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                script_id, body.name, body.description,
                actions_json, channels_json, "ACTIVE", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()

    log.info("warmup_script_created", script_id=script_id, name=body.name)
    return _row_to_dict(row)


@router.get("/scripts")
async def list_scripts(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List warmup scripts with optional status filter."""
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
        f"SELECT COUNT(*) AS total FROM tg_warmup_scripts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_warmup_scripts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/scripts/{script_id}")
async def get_script(
    script_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single warmup script with its run history."""
    row = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Warmup script not found")

    data = _row_to_dict(row)

    # Attach recent runs
    runs = db.execute(
        "SELECT * FROM tg_warmup_runs WHERE script_id = ? ORDER BY created_at DESC LIMIT 10",
        [script_id],
    ).fetchall()
    data["recent_runs"] = [_run_to_dict(r) for r in runs]

    return data


@router.patch("/scripts/{script_id}")
async def update_script(
    script_id: str,
    body: ScriptUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update a warmup script."""
    row = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Warmup script not found")

    updates: list[str] = []
    params: list[Any] = []

    if body.name is not None:
        updates.append("name = ?")
        params.append(body.name)
    if body.description is not None:
        updates.append("description = ?")
        params.append(body.description)
    if body.actions is not None:
        _validate_actions(body.actions)
        updates.append("actions = ?")
        params.append(json.dumps([a.model_dump() for a in body.actions]))
    if body.target_channels is not None:
        updates.append("target_channels = ?")
        params.append(json.dumps(body.target_channels))
    if body.status is not None:
        if body.status not in VALID_SCRIPT_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{body.status}'. Must be one of: {', '.join(sorted(VALID_SCRIPT_STATUSES))}",
            )
        updates.append("status = ?")
        params.append(body.status)

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    now = _now()
    updates.append("updated_at = ?")
    params.append(now)
    params.append(script_id)

    try:
        db.execute(
            f"UPDATE tg_warmup_scripts SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()

    log.info("warmup_script_updated", script_id=script_id)
    return _row_to_dict(row)


@router.delete("/scripts/{script_id}")
async def delete_script(
    script_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a warmup script and its runs (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Warmup script not found")

    try:
        db.execute("DELETE FROM tg_warmup_scripts WHERE id = ?", [script_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("warmup_script_deleted", script_id=script_id)
    return {"status": "deleted", "id": script_id}


# ---------------------------------------------------------------------------
# Run a script
# ---------------------------------------------------------------------------

@router.post("/scripts/{script_id}/run", status_code=status.HTTP_201_CREATED)
async def run_script(
    script_id: str,
    body: RunScriptBody,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Run a warmup script on selected accounts.

    Creates a tg_warmup_runs record and dispatches a Celery task.
    """
    # Validate script exists and is active
    script = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not script:
        raise HTTPException(status_code=404, detail="Warmup script not found")
    if script["status"] != "ACTIVE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot run script in status '{script['status']}'. Must be ACTIVE.",
        )

    # Validate account_ids not empty
    if not body.account_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one account_id is required",
        )

    # Verify accounts exist
    placeholders = ", ".join("?" for _ in body.account_ids)
    found_rows = db.execute(
        f"SELECT id FROM tg_accounts WHERE id IN ({placeholders})",
        body.account_ids,
    ).fetchall()
    found_ids = {r["id"] for r in found_rows}
    missing = [aid for aid in body.account_ids if aid not in found_ids]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Account(s) not found: {', '.join(missing[:5])}",
        )

    # Create run record
    now = _now()
    run_id = str(uuid.uuid4())

    # Count total actions from script
    actions = json.loads(script["actions"] or "[]")
    total_actions = sum(a.get("count", 1) for a in actions) * len(body.account_ids)

    try:
        db.execute(
            """INSERT INTO tg_warmup_runs
                (id, script_id, account_ids, status, total_actions, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                run_id, script_id, json.dumps(body.account_ids),
                "PENDING", total_actions, now, now,
            ],
        )
        # Increment total_runs on script
        db.execute(
            "UPDATE tg_warmup_scripts SET total_runs = total_runs + 1, updated_at = ? WHERE id = ?",
            [now, script_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Engine down → 503. The run row was inserted as PENDING above, so it stays
    # PENDING (never falsely shows as running with no worker behind it).
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.warmup_script", args=[workspace_id, run_id])
    log.info("warmup_script_dispatched", run_id=run_id, script_id=script_id,
             accounts=len(body.account_ids))

    row = db.execute(
        "SELECT * FROM tg_warmup_runs WHERE id = ?", [run_id]
    ).fetchone()

    return _run_to_dict(row)


# ---------------------------------------------------------------------------
# Run listing
# ---------------------------------------------------------------------------

@router.get("/runs")
async def list_runs(
    _token: AdminAuth,
    db: WorkspaceDB,
    script_id: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List warmup runs with optional filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if script_id:
        conditions.append("script_id = ?")
        params.append(script_id)
    if status_filter:
        if status_filter not in VALID_RUN_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_RUN_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_warmup_runs {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"""SELECT r.*, s.name AS script_name
            FROM tg_warmup_runs r
            LEFT JOIN tg_warmup_scripts s ON s.id = r.script_id
            {where}
            ORDER BY r.created_at DESC LIMIT ? OFFSET ?""",
        [*params, limit, offset],
    ).fetchall()

    items = []
    for r in rows:
        d = _run_to_dict(r)
        d["script_name"] = r["script_name"]
        items.append(d)

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get warmup run details with per-account results."""
    row = db.execute(
        """SELECT r.*, s.name AS script_name, s.actions AS script_actions
           FROM tg_warmup_runs r
           LEFT JOIN tg_warmup_scripts s ON s.id = r.script_id
           WHERE r.id = ?""",
        [run_id],
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Warmup run not found")

    data = _run_to_dict(row)
    data["script_name"] = row["script_name"]
    try:
        data["script_actions"] = json.loads(row["script_actions"] or "[]")
    except (json.JSONDecodeError, TypeError):
        data["script_actions"] = []

    return data
