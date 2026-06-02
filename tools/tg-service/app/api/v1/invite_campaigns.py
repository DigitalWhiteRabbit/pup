"""CRUD + control endpoints for invite campaigns."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/invite-campaigns", tags=["invite-campaigns"])

log = structlog.get_logger(__name__)

VALID_STATUSES = {
    "DRAFT", "SCHEDULED", "RUNNING", "PAUSED",
    "COMPLETED", "STOPPED", "EMERGENCY_STOPPED",
}

VALID_MODES = {"DIRECT", "INVITE_LINK"}

ATTEMPT_RESULTS = {
    "SUCCESS", "PRIVACY_RESTRICTED", "ALREADY_PARTICIPANT",
    "USER_NOT_FOUND", "PEER_FLOOD", "FAILED",
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class InviteCampaignCreate(BaseModel):
    name: str
    mode: str = "DIRECT"
    target_channel_id: str | None = None
    target_channel_title: str | None = None
    audience_id: str | None = None
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


def _row_to_attempt(row: dict[str, Any]) -> dict[str, Any]:
    """Convert an invite attempt row to dict."""
    return dict(row)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_campaigns(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List invite campaigns with optional status filter."""
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
        f"SELECT COUNT(*) AS total FROM tg_invite_campaigns {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_invite_campaigns {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def campaign_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return aggregate stats across all invite campaigns."""
    row = db.execute("""
        SELECT
            COUNT(*) AS total_campaigns,
            COALESCE(SUM(total_attempts), 0) AS total_invites,
            COALESCE(SUM(success_count), 0) AS total_success,
            COALESCE(SUM(privacy_count), 0) AS total_privacy,
            COALESCE(SUM(already_count), 0) AS total_already,
            COALESCE(SUM(not_found_count), 0) AS total_not_found
        FROM tg_invite_campaigns
    """).fetchone()

    total_invites = row["total_invites"] if row else 0
    total_success = row["total_success"] if row else 0
    success_rate = round(total_success / total_invites * 100, 2) if total_invites > 0 else 0.0

    return {
        "total_campaigns": row["total_campaigns"] if row else 0,
        "total_invites": total_invites,
        "total_success": total_success,
        "total_privacy": row["total_privacy"] if row else 0,
        "total_already": row["total_already"] if row else 0,
        "total_not_found": row["total_not_found"] if row else 0,
        "success_rate": success_rate,
    }


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single invite campaign with attempt stats."""
    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invite campaign not found")

    data = _row_to_dict(row)

    # Attach attempt stats breakdown
    attempt_stats = db.execute("""
        SELECT result, COUNT(*) AS cnt
        FROM tg_invite_attempts
        WHERE campaign_id = ?
        GROUP BY result
    """, [campaign_id]).fetchall()

    data["attempt_stats"] = {r["result"]: r["cnt"] for r in attempt_stats}
    return data


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: InviteCampaignCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new invite campaign."""
    if body.mode not in VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{body.mode}'. Must be one of: {', '.join(sorted(VALID_MODES))}",
        )

    now = _now()
    campaign_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_invite_campaigns
                (id, name, mode, target_channel_id, target_channel_title,
                 audience_id, account_ids, config, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                campaign_id, body.name, body.mode,
                body.target_channel_id, body.target_channel_title,
                body.audience_id, json.dumps(body.account_ids),
                json.dumps(body.config), "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("invite_campaign_created", campaign_id=campaign_id, name=body.name, mode=body.mode)
    return _row_to_dict(row)


@router.delete("/{campaign_id}")
async def delete_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete an invite campaign and its attempts (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Invite campaign not found")

    try:
        db.execute("DELETE FROM tg_invite_campaigns WHERE id = ?", [campaign_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("invite_campaign_deleted", campaign_id=campaign_id)
    return {"status": "deleted", "id": campaign_id}


@router.post("/{campaign_id}/start")
async def start_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set campaign status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invite campaign not found")

    if row["status"] not in ("DRAFT", "PAUSED", "SCHEDULED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start campaign in status '{row['status']}'. Must be DRAFT, PAUSED, or SCHEDULED.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the campaign in its
    # prior status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.invite_campaign", args=[workspace_id, campaign_id])

    try:
        db.execute(
            """UPDATE tg_invite_campaigns
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, campaign_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("invite_campaign_started", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.post("/{campaign_id}/stop")
async def stop_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set campaign status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invite campaign not found")

    terminal = {"COMPLETED", "STOPPED", "EMERGENCY_STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop campaign in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_invite_campaigns SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, campaign_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("invite_campaign_stopped", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.get("/{campaign_id}/attempts")
async def list_attempts(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    result_filter: str | None = Query(None, alias="result"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List attempts for a specific invite campaign."""
    # Verify campaign exists
    existing = db.execute(
        "SELECT id FROM tg_invite_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Invite campaign not found")

    conditions: list[str] = ["campaign_id = ?"]
    params: list[Any] = [campaign_id]

    if result_filter:
        if result_filter not in ATTEMPT_RESULTS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid result '{result_filter}'. Must be one of: {', '.join(sorted(ATTEMPT_RESULTS))}",
            )
        conditions.append("result = ?")
        params.append(result_filter)

    where = f"WHERE {' AND '.join(conditions)}"

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_invite_attempts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_invite_attempts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_attempt(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/{campaign_id}/pause")
async def pause_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Pause a RUNNING invite campaign (P4-24)."""
    row = db.execute("SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invite campaign not found")
    if row["status"] != "RUNNING":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot pause campaign in status '{row['status']}'. Must be RUNNING.",
        )
    db.execute("UPDATE tg_invite_campaigns SET status='PAUSED', updated_at=? WHERE id=?", [_now(), campaign_id])
    db.commit()
    log.info("invite_campaign_paused", campaign_id=campaign_id)
    return _row_to_dict(db.execute("SELECT * FROM tg_invite_campaigns WHERE id=?", [campaign_id]).fetchone())


@router.post("/{campaign_id}/resume")
async def resume_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Resume a PAUSED invite campaign (P4-24)."""
    row = db.execute("SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invite campaign not found")
    if row["status"] != "PAUSED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot resume campaign in status '{row['status']}'. Must be PAUSED.",
        )
    from app.tasks.dispatch import dispatch_task
    dispatch_task("pup_tg.invite_campaign", args=[workspace_id, campaign_id])
    db.execute("UPDATE tg_invite_campaigns SET status='RUNNING', updated_at=? WHERE id=?", [_now(), campaign_id])
    db.commit()
    log.info("invite_campaign_resumed", campaign_id=campaign_id)
    return _row_to_dict(db.execute("SELECT * FROM tg_invite_campaigns WHERE id=?", [campaign_id]).fetchone())
