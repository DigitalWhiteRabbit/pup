"""Warmup management endpoints for Telegram accounts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/warmup", tags=["warmup"])

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class WarmupAccountStatus(BaseModel):
    account_id: str
    phone: str
    status: str
    warmup_level: int
    warmup_profile: str | None = None
    actions_count: int
    last_action_at: str | None = None


class WarmupStatusResponse(BaseModel):
    accounts: list[WarmupAccountStatus]
    total: int


class WarmupActionResponse(BaseModel):
    account_id: str
    status: str
    message: str
    task_id: str | None = None


class WarmupLogEntry(BaseModel):
    id: str
    action_type: str
    target_type: str | None = None
    target_id: str | None = None
    success: bool
    error_code: str | None = None
    created_at: str | None = None


class WarmupLogResponse(BaseModel):
    account_id: str
    entries: list[WarmupLogEntry]
    total: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status")
async def warmup_status(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> WarmupStatusResponse:
    """For each account in WARMING status, return action count and last action time."""
    rows = db.execute(
        """
        SELECT
            a.id AS account_id,
            a.phone,
            a.status,
            a.warmup_level,
            a.warmup_profile,
            COALESCE(w.actions_count, 0) AS actions_count,
            w.last_action_at
        FROM tg_accounts a
        LEFT JOIN (
            SELECT
                account_id,
                COUNT(*) AS actions_count,
                MAX(created_at) AS last_action_at
            FROM tg_warmup_actions
            GROUP BY account_id
        ) w ON w.account_id = a.id
        WHERE a.status = 'WARMING'
        ORDER BY a.created_at ASC
        """
    ).fetchall()

    accounts: list[WarmupAccountStatus] = []
    for r in rows:
        accounts.append(WarmupAccountStatus(
            account_id=r["account_id"],
            phone=r["phone"],
            status=r["status"],
            warmup_level=r["warmup_level"],
            warmup_profile=r["warmup_profile"],
            actions_count=r["actions_count"],
            last_action_at=r["last_action_at"],
        ))

    return WarmupStatusResponse(accounts=accounts, total=len(accounts))


@router.post("/{account_id}/start")
async def start_warmup(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> WarmupActionResponse:
    """Set account status to WARMING and dispatch the first warmup session immediately."""
    existing = db.execute(
        "SELECT id, phone, status FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Account not found")

    current_status = existing["status"]
    if current_status in ("BANNED", "DEAD", "SPAM_BLOCKED"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot start warmup: account status is {current_status}",
        )

    now = _now()
    task_id: str | None = None

    # If already warming, just dispatch another session
    if current_status == "WARMING":
        task_id = _dispatch_warmup_session(workspace_id, account_id)
        return WarmupActionResponse(
            account_id=account_id,
            status="WARMING",
            message="Account is already warming up; dispatched additional session",
            task_id=task_id,
        )

    try:
        db.execute(
            "UPDATE tg_accounts SET status = 'WARMING', updated_at = ? WHERE id = ?",
            [now, account_id],
        )
        db.execute(
            """
            INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message)
            VALUES (?, ?, ?, ?, ?)
            """,
            ["account.warmup_start", "INFO", "account", account_id,
             f"Warmup started for {existing['phone']}"],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Dispatch first warmup session immediately. The account is committed WARMING
    # first (a separate worker process must see it on disk), so if the broker is
    # down dispatch_task raises 503 — compensate the status back to its pre-warmup
    # value rather than leaving the account falsely stuck in WARMING.
    try:
        task_id = _dispatch_warmup_session(workspace_id, account_id)
    except HTTPException:
        db.execute(
            "UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?",
            [current_status, _now(), account_id],
        )
        db.execute(
            """
            INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message)
            VALUES (?, ?, ?, ?, ?)
            """,
            ["account.warmup_start_failed", "WARNING", "account", account_id,
             f"Warmup dispatch failed for {existing['phone']}; reverted to {current_status}"],
        )
        db.commit()
        log.error(
            "warmup_dispatch_failed",
            account_id=account_id,
            phone=existing["phone"],
            reverted_to=current_status,
        )
        raise

    log.info(
        "warmup_started",
        account_id=account_id,
        phone=existing["phone"],
        task_id=task_id,
    )

    return WarmupActionResponse(
        account_id=account_id,
        status="WARMING",
        message=f"Warmup started for {existing['phone']}",
        task_id=task_id,
    )


@router.post("/{account_id}/stop")
async def stop_warmup(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> WarmupActionResponse:
    """Set account status to PAUSED (stop warming)."""
    existing = db.execute(
        "SELECT id, phone, status FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Account not found")

    current_status = existing["status"]
    if current_status == "PAUSED":
        return WarmupActionResponse(
            account_id=account_id,
            status="PAUSED",
            message="Account is already paused",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_accounts SET status = 'PAUSED', updated_at = ? WHERE id = ?",
            [now, account_id],
        )
        db.execute(
            """
            INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message)
            VALUES (?, ?, ?, ?, ?)
            """,
            ["account.warmup_stop", "INFO", "account", account_id,
             f"Warmup stopped for {existing['phone']} (was {current_status})"],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("warmup_stopped", account_id=account_id, phone=existing["phone"])

    return WarmupActionResponse(
        account_id=account_id,
        status="PAUSED",
        message=f"Warmup stopped for {existing['phone']}",
    )


@router.get("/log/{account_id}")
async def warmup_log(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> WarmupLogResponse:
    """Return recent warmup actions for an account."""
    # Verify account exists
    existing = db.execute(
        "SELECT id FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Account not found")

    # Count total
    count_row = db.execute(
        "SELECT COUNT(*) AS total FROM tg_warmup_actions WHERE account_id = ?",
        [account_id],
    ).fetchone()
    total = count_row["total"] if count_row else 0

    # Fetch log entries (newest first)
    rows = db.execute(
        """SELECT id, action_type, target_type, target_id, success, error_code, created_at
           FROM tg_warmup_actions
           WHERE account_id = ?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?""",
        [account_id, limit, offset],
    ).fetchall()

    entries: list[WarmupLogEntry] = []
    for r in rows:
        entries.append(WarmupLogEntry(
            id=r["id"],
            action_type=r["action_type"],
            target_type=r["target_type"],
            target_id=r["target_id"],
            success=bool(r["success"]),
            error_code=r["error_code"],
            created_at=r["created_at"],
        ))

    return WarmupLogResponse(
        account_id=account_id,
        entries=entries,
        total=total,
    )


@router.get("/progress")
async def warmup_progress(
    _token: AdminAuth,
    db: WorkspaceDB,
    days: int = Query(14, ge=1, le=90),
) -> dict:
    """Return warmup actions count per day for the last N days.

    Used by the progress chart on the warmup screen.
    """
    rows = db.execute(
        """SELECT date(created_at) AS day, COUNT(*) AS cnt
           FROM tg_warmup_actions
           WHERE created_at >= datetime('now', ?)
           GROUP BY date(created_at)
           ORDER BY day ASC""",
        [f"-{days} days"],
    ).fetchall()
    by_day = [{"date": r["day"], "count": r["cnt"]} for r in rows]
    total = sum(r["cnt"] for r in rows)
    return {"by_day": by_day, "total": total, "days": days}


# ---------------------------------------------------------------------------
# Internal: dispatch Celery warmup task
# ---------------------------------------------------------------------------

def _dispatch_warmup_session(workspace_id: str, account_id: str) -> str:
    """Dispatch a warmup_session Celery task (fail-fast → 503 if broker is down).

    Reuses the shared :func:`dispatch_task` helper instead of calling
    ``apply_async`` directly, so a dead broker surfaces as HTTP 503 rather than a
    silent success that leaves the account stuck in WARMING. Returns the
    dispatched task id; raises ``HTTPException(503)`` if the broker is unreachable.
    """
    from app.tasks.dispatch import dispatch_task

    return dispatch_task(
        "pup_tg.warmup_session",
        args=[workspace_id, account_id],
    )
