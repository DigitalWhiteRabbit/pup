"""CRUD + control endpoints for join-chat tasks.

Allows joining multiple accounts to multiple chats/channels with
configurable intervals between joins. After joining, reads chat
description for later use.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/join-chats", tags=["join-chats"])

log = structlog.get_logger(__name__)

VALID_STATUSES = {
    "PENDING", "RUNNING", "COMPLETED", "FAILED", "STOPPED",
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class JoinTaskCreate(BaseModel):
    name: str | None = None
    target_chats: list[str] = Field(..., min_length=1)
    account_ids: list[str] = Field(..., min_length=1)
    join_interval_min: int = Field(default=30, ge=5, le=600)
    join_interval_max: int = Field(default=120, ge=10, le=1800)
    # Anti-ban gate: by default the API refuses to join "naked" accounts
    # (no avatar / no username — the #1 auto-ban trigger for fresh accounts).
    # The UI re-sends with this set to True after the operator confirms.
    force_low_humanity: bool = False
    # P4-13/14: per-account daily join cap + consecutive-ban auto-stop (read by worker).
    daily_limit: int = Field(default=50, ge=1, le=200)
    ban_auto_stop_count: int = Field(default=3, ge=0, le=50)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Accounts below this warmup level are treated as "cold" — fresh, no activity
# history, the classic profile an anti-spam bot auto-bans on first join.
_WARMUP_MIN_LEVEL = 20


def _assess_humanity(db: Any, account_ids: list[str]) -> list[dict[str, Any]]:
    """Flag accounts likely to be auto-banned on join (profile OR not warmed up).

    Two anti-ban dimensions, both checked here:
    - **Profile ("naked"):** no avatar OR no username is the dominant anti-spam
      trigger for fresh accounts. ``twofa`` is ignored — invisible to a group's
      anti-spam; only avatar/username/bio matter.
    - **Warmup ("cold"):** a brand-new account with ``warmup_level`` below
      :data:`_WARMUP_MIN_LEVEL` has no activity history and looks like a bot.

    Returns one entry per RISKY account (the operator can still force the join,
    or warm it up first). An account is risky when it is naked, cold, or was
    never health-checked (no humanity data — we can't vouch for it). Each entry
    carries ``warmup_level`` + ``can_warmup`` so the UI can offer one-click
    warmup for exactly the accounts that need it.
    """
    if not account_ids:
        return []
    placeholders = ",".join("?" for _ in account_ids)
    rows = db.execute(
        f"SELECT id, phone, username, first_name, status, warmup_level, metadata "
        f"FROM tg_accounts WHERE id IN ({placeholders})",
        account_ids,
    ).fetchall()

    risky: list[dict[str, Any]] = []
    for r in rows:
        try:
            meta = json.loads(r["metadata"]) if r["metadata"] else {}
        except (ValueError, TypeError):
            meta = {}
        hum = meta.get("humanity") if isinstance(meta.get("humanity"), dict) else None

        label = r["phone"] or r["username"] or r["first_name"] or r["id"]
        level = r["warmup_level"] or 0
        # Warmup can be (re)started for any account not in a terminal/blocked
        # state. WARMING accounts are already warming — no need to offer it.
        can_warmup = r["status"] not in ("BANNED", "DEAD", "SPAM_BLOCKED", "WARMING")
        cold = level < _WARMUP_MIN_LEVEL

        missing: list[str] = []
        reasons: list[str] = []

        if not hum:
            missing.append("не проверен")
            reasons.append("аккаунт не проверялся («Чек»)")
        else:
            if not hum.get("avatar"):
                missing.append("нет аватара")
            if not hum.get("username"):
                missing.append("нет username")
            if not hum.get("bio"):
                missing.append("нет bio")
            if not hum.get("avatar") or not hum.get("username"):
                reasons.append("«голый» профиль")

        if cold:
            missing.append(f"не прогрет (ур. {level})")
            reasons.append("аккаунт не прогрет")

        naked = bool(hum) and (not hum.get("avatar") or not hum.get("username"))
        if naked or cold or not hum:
            risky.append({
                "account_id": r["id"], "account": label,
                "missing": missing,
                "score": hum.get("score") if hum else None,
                "warmup_level": level,
                "can_warmup": can_warmup,
                "reason": "; ".join(reasons) or "высокий риск авто-бана при вступлении",
            })
    return risky


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Convert a raw SQLite row into an API-compatible dict."""
    data = dict(row)
    for field in ("target_chats", "account_ids", "results"):
        if data.get(field):
            try:
                data[field] = json.loads(data[field])
            except (json.JSONDecodeError, TypeError):
                data[field] = []
        else:
            data[field] = []
    return data


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_tasks(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List join tasks with optional status filter."""
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
        f"SELECT COUNT(*) AS total FROM tg_join_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_join_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{task_id}")
async def get_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single join task with results."""
    row = db.execute(
        "SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Join task not found")
    return _row_to_dict(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_task(
    body: JoinTaskCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Create a join task and dispatch it to Celery immediately."""
    if body.join_interval_min > body.join_interval_max:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="join_interval_min must be <= join_interval_max",
        )

    # Anti-ban gate: refuse to join "naked" accounts unless explicitly forced.
    if not body.force_low_humanity:
        risky = _assess_humanity(db, body.account_ids)
        if risky:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "LOW_HUMANITY",
                    "message": (
                        f"{len(risky)} аккаунт(ов) с высоким риском авто-бана "
                        f"(голый профиль / не прогрет / не проверен). Прогрейте "
                        f"и/или заполните профиль, либо подтвердите вступление."
                    ),
                    "risky": risky,
                },
            )

    now = _now()
    task_id = str(uuid.uuid4())
    nc, na = len(body.target_chats), len(body.account_ids)
    if body.name:
        name = body.name
    elif nc == 1:
        # Single chat — name it after the chat for an at-a-glance log entry.
        name = f"Вступление в {body.target_chats[0]} ({na} акк.)"
    else:
        name = f"Вступление: {nc} чат(ов), {na} акк."

    try:
        cfg_json = json.dumps({
            "daily_limit": body.daily_limit,
            "ban_auto_stop_count": body.ban_auto_stop_count,
        })
        db.execute(
            """INSERT INTO tg_join_tasks
                (id, name, target_chats, account_ids,
                 join_interval_min, join_interval_max, config,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, name,
                json.dumps(body.target_chats),
                json.dumps(body.account_ids),
                body.join_interval_min,
                body.join_interval_max,
                cfg_json,
                "PENDING", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Engine down → 503. The task row was inserted as PENDING above, so it stays
    # PENDING (never falsely shows as running with no worker behind it).
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.join_chats", args=[workspace_id, task_id])
    log.info("join_task_dispatched", task_id=task_id, workspace_id=workspace_id)

    row = db.execute(
        "SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("join_task_created", task_id=task_id, chats=len(body.target_chats),
             accounts=len(body.account_ids))
    return _row_to_dict(row)


@router.post("/{task_id}/stop")
async def stop_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Stop a running join task."""
    row = db.execute(
        "SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Join task not found")

    terminal = {"COMPLETED", "FAILED", "STOPPED"}
    if row["status"] in terminal:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stop task in terminal status '{row['status']}'.",
        )

    now = _now()
    try:
        db.execute(
            "UPDATE tg_join_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            ["STOPPED", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("join_task_stopped", task_id=task_id)
    return _row_to_dict(row)


@router.delete("/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a join task."""
    existing = db.execute(
        "SELECT id FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Join task not found")

    try:
        db.execute("DELETE FROM tg_join_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("join_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/{task_id}/retry-failed", status_code=status.HTTP_201_CREATED)
async def retry_failed_chats(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict:
    """Create a new task with only the FAILED chats from the given task.

    Copies account_ids, intervals, and config; sets target_chats to the
    distinct set of chats that got FAILED status in the original task results.
    """
    import json as _json

    row = db.execute("SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Join task not found")

    results = _json.loads(row["results"] or "[]")
    failed_chats = list({
        r["chat"]
        for r in results
        if r.get("status") == "FAILED" and r.get("chat")
    })

    if not failed_chats:
        raise HTTPException(
            status_code=400,
            detail="No FAILED chats found in this task to retry",
        )

    import uuid as _uuid
    now = _now()
    new_id = str(_uuid.uuid4())
    new_name = (row["name"] or "retry") + " [retry]"

    try:
        db.execute(
            """INSERT INTO tg_join_tasks
               (id, name, target_chats, account_ids, join_interval_min,
                join_interval_max, config, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)""",
            [
                new_id, new_name,
                _json.dumps(failed_chats),
                row["account_ids"] or "[]",
                row["join_interval_min"] or 30,
                row["join_interval_max"] or 120,
                row["config"] or "{}",
                now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("join_task_retry_created", original_id=task_id, new_id=new_id, chats=len(failed_chats))
    new_row = db.execute("SELECT * FROM tg_join_tasks WHERE id = ?", [new_id]).fetchone()
    return _row_to_dict(new_row)
