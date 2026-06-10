"""CRUD + control endpoints for DM (direct message) campaigns."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/dm-campaigns", tags=["dm-campaigns"])

log = structlog.get_logger(__name__)

VALID_STATUSES = {
    "DRAFT", "SCHEDULED", "RUNNING", "PAUSED",
    "COMPLETED", "STOPPED", "EMERGENCY_STOPPED",
}

VALID_DISTRIBUTIONS = {"ROUND_ROBIN", "GEO_MATCHED", "RANDOM"}

MSG_STATUSES = {"PENDING", "SENT", "FAILED", "REPLIED", "SKIPPED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class DmCampaignCreate(BaseModel):
    name: str
    audience_id: str | None = None
    template_id: str | None = None
    account_ids: list[str] = Field(default_factory=list)
    distribution: str = "ROUND_ROBIN"
    config: dict[str, Any] = Field(default_factory=dict)


class DmCampaignUpdate(BaseModel):
    name: str | None = None
    audience_id: str | None = None
    template_id: str | None = None
    account_ids: list[str] | None = None
    distribution: str | None = None
    config: dict[str, Any] | None = None


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


def _row_to_msg(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a DM message row to dict."""
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
    """List DM campaigns with optional status filter and pagination."""
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
        f"SELECT COUNT(*) AS total FROM tg_dm_campaigns {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_dm_campaigns {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/stats")
async def campaign_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return aggregate stats across all DM campaigns."""
    row = db.execute("""
        SELECT
            COUNT(*) AS total_campaigns,
            COALESCE(SUM(sent_count), 0) AS total_sent,
            COALESCE(SUM(failed_count), 0) AS total_failed,
            COALESCE(SUM(replied_count), 0) AS total_replied
        FROM tg_dm_campaigns
    """).fetchone()

    total_sent = row["total_sent"] if row else 0
    total_replied = row["total_replied"] if row else 0
    conversion_rate = round(total_replied / total_sent * 100, 2) if total_sent > 0 else 0.0

    return {
        "total_campaigns": row["total_campaigns"] if row else 0,
        "total_sent": total_sent,
        "total_failed": row["total_failed"] if row else 0,
        "total_replied": total_replied,
        "conversion_rate": conversion_rate,
    }


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single DM campaign with message stats."""
    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    data = _row_to_dict(row)

    # Attach message stats breakdown
    msg_stats = db.execute("""
        SELECT status, COUNT(*) AS cnt
        FROM tg_dm_messages
        WHERE campaign_id = ?
        GROUP BY status
    """, [campaign_id]).fetchall()

    data["message_stats"] = {r["status"]: r["cnt"] for r in msg_stats}
    return data


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: DmCampaignCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new DM campaign."""
    if body.distribution not in VALID_DISTRIBUTIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid distribution '{body.distribution}'. Must be one of: {', '.join(sorted(VALID_DISTRIBUTIONS))}",
        )

    now = _now()
    campaign_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_dm_campaigns
                (id, name, audience_id, template_id, account_ids, distribution, config,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                campaign_id, body.name, body.audience_id, body.template_id,
                json.dumps(body.account_ids), body.distribution,
                json.dumps(body.config), "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("dm_campaign_created", campaign_id=campaign_id, name=body.name)
    return _row_to_dict(row)


@router.patch("/{campaign_id}")
async def update_campaign(
    campaign_id: str,
    body: DmCampaignUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update a draft DM campaign."""
    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    if row["status"] != "DRAFT":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot update campaign in status '{row['status']}'. Must be DRAFT.",
        )

    updates: list[str] = []
    params: list[Any] = []

    if body.name is not None:
        updates.append("name = ?")
        params.append(body.name)
    if body.audience_id is not None:
        updates.append("audience_id = ?")
        params.append(body.audience_id)
    if body.template_id is not None:
        updates.append("template_id = ?")
        params.append(body.template_id)
    if body.account_ids is not None:
        updates.append("account_ids = ?")
        params.append(json.dumps(body.account_ids))
    if body.distribution is not None:
        if body.distribution not in VALID_DISTRIBUTIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid distribution '{body.distribution}'.",
            )
        updates.append("distribution = ?")
        params.append(body.distribution)
    if body.config is not None:
        updates.append("config = ?")
        params.append(json.dumps(body.config))

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    now = _now()
    updates.append("updated_at = ?")
    params.append(now)
    params.append(campaign_id)

    try:
        db.execute(
            f"UPDATE tg_dm_campaigns SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("dm_campaign_updated", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.delete("/{campaign_id}")
async def delete_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a DM campaign and its messages (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    try:
        db.execute("DELETE FROM tg_dm_campaigns WHERE id = ?", [campaign_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("dm_campaign_deleted", campaign_id=campaign_id)
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
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    if row["status"] not in ("DRAFT", "PAUSED", "SCHEDULED"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start campaign in status '{row['status']}'. Must be DRAFT, PAUSED, or SCHEDULED.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the campaign in its
    # prior status (DRAFT/PAUSED) instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.dm_campaign", args=[workspace_id, campaign_id])
    log.info("dm_campaign_dispatched", campaign_id=campaign_id)

    try:
        db.execute(
            """UPDATE tg_dm_campaigns
               SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, campaign_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("dm_campaign_started", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.post("/{campaign_id}/pause")
async def pause_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set campaign status to PAUSED."""
    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    if row["status"] != "RUNNING":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot pause campaign in status '{row['status']}'. Must be RUNNING.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_dm_campaigns SET status = ?, paused_at = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", now, now, campaign_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("dm_campaign_paused", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.post("/{campaign_id}/stop")
async def stop_campaign(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Set campaign status to STOPPED."""
    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    terminal = {"COMPLETED", "STOPPED", "EMERGENCY_STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop campaign in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_dm_campaigns SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, campaign_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()

    log.info("dm_campaign_stopped", campaign_id=campaign_id)
    return _row_to_dict(row)


@router.get("/{campaign_id}/messages")
async def list_messages(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List messages for a specific DM campaign."""
    # Verify campaign exists
    existing = db.execute(
        "SELECT id FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="DM campaign not found")

    conditions: list[str] = ["campaign_id = ?"]
    params: list[Any] = [campaign_id]

    if status_filter:
        if status_filter not in MSG_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(MSG_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}"

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_dm_messages {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_dm_messages {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_msg(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/{campaign_id}/check-replies")
async def check_replies(
    campaign_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Check sent DM messages for replies (P4-20).

    For each SENT message, connects the sender account and checks if the
    recipient has replied. Updates status to REPLIED and increments
    campaign.replied_count. Best-effort — failures per account are logged
    and skipped. Uses NO_PROXY guard.
    """
    row = db.execute(
        "SELECT id, account_ids FROM tg_dm_campaigns WHERE id = ?", [campaign_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Campaign not found")

    sent_msgs = db.execute(
        """SELECT id, account_id, recipient_user_id FROM tg_dm_messages
           WHERE campaign_id = ? AND status = 'SENT'
           LIMIT 100""",
        [campaign_id],
    ).fetchall()

    if not sent_msgs:
        return {"checked": 0, "newly_replied": 0}

    from app.telegram.client_pool import disconnect_client, get_client_for_account

    import asyncio as _asyncio
    checked = 0
    newly_replied = 0
    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()

    # Group by account to reuse connections
    by_account: dict = {}
    for msg in sent_msgs:
        by_account.setdefault(msg["account_id"], []).append(msg)

    for acc_id, msgs in by_account.items():
        client = None
        try:
            client = await get_client_for_account(acc_id, db)
            for msg in msgs:
                uid = msg["recipient_user_id"]
                if not uid:
                    continue
                try:
                    recent = await client.get_messages(uid, limit=3)
                    for m in recent:
                        if m and getattr(m, "out", False) is False and m.text:
                            # Received message (not sent by us) → reply
                            db.execute(
                                """UPDATE tg_dm_messages
                                   SET status='REPLIED', replied_at=?, reply_text=?
                                   WHERE id=?""",
                                [now, (m.text or "")[:500], msg["id"]],
                            )
                            db.execute(
                                """UPDATE tg_dm_campaigns
                                   SET replied_count = replied_count + 1, updated_at=?
                                   WHERE id=?""",
                                [now, campaign_id],
                            )
                            newly_replied += 1
                            break
                    checked += 1
                except Exception:
                    pass
            db.commit()
        except HTTPException:
            pass
        except Exception as exc:
            import structlog as _sl
            _sl.get_logger(__name__).warning("check_replies_acc_failed", account_id=acc_id, error=str(exc)[:100])
        finally:
            await disconnect_client(client)

    return {"checked": checked, "newly_replied": newly_replied}
