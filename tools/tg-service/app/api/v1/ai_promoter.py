"""AI Promoter — personas & message queue for autonomous chat posting."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/ai-promoter", tags=["ai-promoter"])

log = structlog.get_logger(__name__)

VALID_STRATEGIES = {"soft", "medium", "aggressive"}
VALID_PERSONA_STATUSES = {"DRAFT", "ACTIVE", "PAUSED"}
VALID_MSG_STATUSES = {"PENDING", "APPROVED", "SENT", "REJECTED", "FAILED"}
VALID_RATINGS = {"good", "bad"}

# JSON column names that need loads/dumps
_PERSONA_JSON_COLS = ("account_ids", "target_channels", "rag_doc_ids", "schedule")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class GenerateReplyRequest(BaseModel):
    persona_id: str
    original_message: str
    chat_context: str = ""
    chat_id: str = ""


class PersonaCreate(BaseModel):
    name: str
    account_ids: list[str] = Field(default_factory=list)
    niche: str | None = None
    bio: str | None = None
    personality: str | None = None
    strategy: str = "soft"
    system_prompt: str = ""
    ai_model: str = "claude-haiku-4-5"
    temperature: float = 0.8
    target_channels: list[str] = Field(default_factory=list)
    rag_doc_ids: list[str] = Field(default_factory=list)
    schedule: dict[str, Any] = Field(default_factory=dict)
    dm_enabled: bool = True
    dm_reply_to_all: bool = True
    context_depth: int = 50


class RateMessageRequest(BaseModel):
    rating: str | None = None
    note: str | None = None
    clear: bool = False  # un-rate: reset moderator_rating back to NULL


class PersonaUpdate(BaseModel):
    name: str | None = None
    account_ids: list[str] | None = None
    niche: str | None = None
    bio: str | None = None
    personality: str | None = None
    strategy: str | None = None
    system_prompt: str | None = None
    ai_model: str | None = None
    temperature: float | None = None
    target_channels: list[str] | None = None
    rag_doc_ids: list[str] | None = None
    schedule: dict[str, Any] | None = None
    dm_enabled: bool | None = None
    dm_reply_to_all: bool | None = None
    context_depth: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_persona(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    _list_cols = {"account_ids", "target_channels", "rag_doc_ids"}
    for col in _PERSONA_JSON_COLS:
        if data.get(col):
            try:
                data[col] = json.loads(data[col])
            except (json.JSONDecodeError, TypeError):
                data[col] = [] if col in _list_cols else {}
        else:
            data[col] = [] if col in _list_cols else {}
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
                (id, name, account_ids, niche, bio, personality, strategy,
                 system_prompt, ai_model, temperature, target_channels,
                 rag_doc_ids, schedule, dm_enabled, dm_reply_to_all, context_depth,
                 status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                persona_id, body.name, json.dumps(body.account_ids),
                body.niche, body.bio, body.personality, body.strategy,
                body.system_prompt, body.ai_model, body.temperature,
                json.dumps(body.target_channels), json.dumps(body.rag_doc_ids),
                json.dumps(body.schedule), 1 if body.dm_enabled else 0,
                1 if body.dm_reply_to_all else 0,
                body.context_depth, "DRAFT", now, now,
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
    for json_col in ("account_ids", "target_channels", "rag_doc_ids"):
        if json_col in updates:
            updates[json_col] = json.dumps(updates[json_col])
    if "schedule" in updates:
        updates["schedule"] = json.dumps(updates["schedule"])
    if "dm_enabled" in updates:
        updates["dm_enabled"] = 1 if updates["dm_enabled"] else 0
    if "dm_reply_to_all" in updates:
        updates["dm_reply_to_all"] = 1 if updates["dm_reply_to_all"] else 0

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
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set persona status to ACTIVE and dispatch AI promoter task."""
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
    # Mint a fresh loop token so any stale self-rescheduling loop from a previous
    # activation stops on its next tick (prevents duplicate loops on re-activate).
    import uuid
    schedule = json.loads(row["schedule"] or "{}")
    loop_token = uuid.uuid4().hex
    schedule["loop_token"] = loop_token
    # Commit ACTIVE first, then dispatch. This avoids a dispatch-before-commit
    # race where the worker (a separate process) reads the persona off disk
    # before the commit lands and skips it as not-yet-ACTIVE. If the dispatch
    # then fails, we compensate with an explicit UPDATE back to PAUSED rather
    # than relying on rollback (which would be a no-op after the commit).
    db.execute(
        "UPDATE tg_ai_personas SET status = ?, schedule = ?, updated_at = ? WHERE id = ?",
        ["ACTIVE", json.dumps(schedule, ensure_ascii=False), now, persona_id],
    )
    db.commit()

    # Reuse the shared fail-fast dispatch. The persona is committed ACTIVE first
    # (deliberately — see above) so on a dispatch failure we compensate back to
    # PAUSED and re-raise the 503 rather than leaving it falsely ACTIVE.
    from app.tasks.dispatch import dispatch_task

    try:
        dispatch_task("pup_tg.ai_agent", args=[workspace_id, persona_id, loop_token])
        log.info("ai_agent_dispatched", persona_id=persona_id)
    except HTTPException:
        db.execute(
            "UPDATE tg_ai_personas SET status = ?, updated_at = ? WHERE id = ?",
            ["PAUSED", _now(), persona_id],
        )
        db.commit()
        log.error("ai_agent_dispatch_failed", persona_id=persona_id)
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
    chat_id: str | None = Query(None),
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

    # Filter by chat — used by the embedded messenger to overlay 👍/👎 rating
    # controls on the agent's own (outgoing) messages in a live chat.
    if chat_id:
        conditions.append("chat_id = ?")
        params.append(chat_id)

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


@router.post("/messages/{message_id}/rate")
async def rate_message(
    message_id: str,
    body: RateMessageRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Rate an AI message 👍/👎 as a human moderator (feeds the learning loop).

    Pass ``clear: true`` to remove an existing rating (toggle off). Otherwise
    ``rating`` must be one of the valid ratings.
    """
    if not body.clear and body.rating not in VALID_RATINGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid rating '{body.rating}'. Must be one of: "
            f"{', '.join(sorted(VALID_RATINGS))}",
        )

    row = db.execute(
        "SELECT id FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")

    try:
        if body.clear:
            # Reset rating (and any note) — the message no longer feeds learning.
            db.execute(
                "UPDATE tg_ai_messages SET moderator_rating = NULL, moderator_note = NULL WHERE id = ?",
                [message_id],
            )
        elif body.note is not None:
            db.execute(
                "UPDATE tg_ai_messages SET moderator_rating = ?, moderator_note = ? WHERE id = ?",
                [body.rating, body.note, message_id],
            )
        else:
            # No note supplied (e.g. messenger 👍/👎) — keep any existing note.
            db.execute(
                "UPDATE tg_ai_messages SET moderator_rating = ? WHERE id = ?",
                [body.rating, message_id],
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_ai_messages WHERE id = ?", [message_id]
    ).fetchone()

    log.info("message_rated", message_id=message_id, rating=(None if body.clear else body.rating))
    return _row_to_message(row)


# ---------------------------------------------------------------------------
# Agent monitor — live activity feed + computed per-chat state
# ---------------------------------------------------------------------------

def _norm_chat(s: str | None) -> str:
    s = (s or "").strip()
    for pre in ("https://t.me/", "http://t.me/", "t.me/", "@"):
        if s.startswith(pre):
            return s[len(pre):]
    return s


@router.get("/activity")
async def list_activity(
    _token: AdminAuth,
    db: WorkspaceDB,
    persona_id: str = Query(...),
    chat_id: str | None = Query(None),
    limit: int = Query(60, ge=1, le=300),
) -> dict[str, Any]:
    """Live activity feed of what the agent did (scan/read/think/sent/skip/sleep)."""
    where = "persona_id = ?"
    params: list[Any] = [persona_id]
    if chat_id:
        # Include persona-level events (chat_id IS NULL) like SLEEP / out-of-hours.
        where += " AND (chat_id = ? OR chat_id IS NULL)"
        params.append(str(chat_id))
    rows = db.execute(
        f"SELECT * FROM tg_ai_activity WHERE {where} ORDER BY created_at DESC LIMIT ?",
        [*params, limit],
    ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        if d.get("meta"):
            try:
                d["meta"] = json.loads(d["meta"])
            except (json.JSONDecodeError, TypeError):
                pass
        items.append(d)
    return {"items": items}


@router.get("/agent-state")
async def agent_state(
    _token: AdminAuth,
    db: WorkspaceDB,
    persona_id: str | None = Query(None),
    account_id: str | None = Query(None),
    chat: str | None = Query(None),
    chat_id: str | None = Query(None),
) -> dict[str, Any]:
    """Computed agent state for a persona (optionally scoped to one chat).

    Resolves the persona by ``persona_id`` or by ``account_id`` (+ optional
    ``chat`` for target matching). Returns status, last action, next scan ETA,
    last reply, today's count, ratings and attached knowledge docs — everything
    the operator's monitor panel needs.
    """
    persona = None
    if persona_id:
        persona = db.execute(
            "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
        ).fetchone()
    elif account_id:
        norm = _norm_chat(chat) if chat else None
        for r in db.execute("SELECT * FROM tg_ai_personas").fetchall():
            accs = json.loads(r["account_ids"] or "[]")
            if account_id not in accs:
                continue
            if norm:
                tcs = [_norm_chat(c) for c in json.loads(r["target_channels"] or "[]")]
                if norm in tcs:
                    persona = r
                    break
                if persona is None:
                    persona = r  # fallback: first persona using this account
            else:
                persona = r
                break

    if not persona:
        return {"found": False}

    persona = dict(persona)
    pid = persona["id"]
    schedule = json.loads(persona.get("schedule") or "{}")

    # Resolve a numeric chat_id for activity/message filtering. Prefer the
    # canonical id from tg_channels (matches what the worker stores as
    # str(entity.id)); the messenger passes a *marked* id (-100…) that won't
    # match, so username resolution wins, with a normalized fallback.
    def _bare_id(s: str) -> str:
        s = str(s)
        if s.startswith("-100"):
            return s[4:]
        return s.lstrip("-")

    cid = None
    if chat:
        nc = _norm_chat(chat)
        chrow = db.execute(
            "SELECT tg_id FROM tg_channels WHERE username = ?", [nc]
        ).fetchone()
        if chrow and chrow["tg_id"] is not None:
            cid = str(chrow["tg_id"])
    if not cid and chat_id:
        cid = _bare_id(chat_id)

    act_where = "persona_id = ?"
    act_params: list[Any] = [pid]
    if cid:
        act_where += " AND (chat_id = ? OR chat_id IS NULL)"
        act_params.append(cid)
    last_act = db.execute(
        f"SELECT kind, message, created_at FROM tg_ai_activity WHERE {act_where} "
        "ORDER BY created_at DESC LIMIT 1",
        act_params,
    ).fetchone()

    sleep_act = db.execute(
        "SELECT meta FROM tg_ai_activity WHERE persona_id = ? AND kind = 'SLEEP' "
        "ORDER BY created_at DESC LIMIT 1",
        [pid],
    ).fetchone()
    next_at = None
    if sleep_act and sleep_act["meta"]:
        try:
            next_at = json.loads(sleep_act["meta"]).get("next_at")
        except (json.JSONDecodeError, TypeError):
            pass

    msg_where = "persona_id = ? AND status = 'SENT'"
    msg_params: list[Any] = [pid]
    if cid:
        msg_where += " AND chat_id = ?"
        msg_params.append(cid)
    last_reply = db.execute(
        f"SELECT ai_text, sent_at FROM tg_ai_messages WHERE {msg_where} "
        "ORDER BY sent_at DESC LIMIT 1",
        msg_params,
    ).fetchone()

    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    today_cnt = db.execute(
        "SELECT COUNT(*) AS c FROM tg_ai_messages WHERE persona_id = ? AND created_at >= ?",
        [pid, today],
    ).fetchone()["c"]
    good = db.execute(
        "SELECT COUNT(*) AS c FROM tg_ai_messages WHERE persona_id = ? AND moderator_rating = 'good'",
        [pid],
    ).fetchone()["c"]
    bad = db.execute(
        "SELECT COUNT(*) AS c FROM tg_ai_messages WHERE persona_id = ? AND moderator_rating = 'bad'",
        [pid],
    ).fetchone()["c"]

    rag_ids = json.loads(persona.get("rag_doc_ids") or "[]")
    rag_titles: list[str] = []
    if rag_ids:
        qs = ",".join("?" * len(rag_ids))
        for row in db.execute(
            f"SELECT title FROM tg_kb_documents WHERE id IN ({qs})", rag_ids
        ).fetchall():
            rag_titles.append(row["title"])

    return {
        "found": True,
        "persona_id": pid,
        "persona_name": persona.get("name"),
        "status": persona.get("status"),
        "scan_interval_sec": int(schedule.get("scan_interval_sec", 180)),
        "approval_mode": (schedule.get("approval_mode") or "AUTO"),
        "dm_enabled": bool(persona.get("dm_enabled")),
        "chat_id": cid,
        "last_action": (
            {"kind": last_act["kind"], "message": last_act["message"], "at": last_act["created_at"]}
            if last_act else None
        ),
        "next_scan_at": next_at,
        "last_reply": (
            {"text": last_reply["ai_text"], "at": last_reply["sent_at"]} if last_reply else None
        ),
        "today_count": today_cnt,
        "ratings": {"good": good, "bad": bad},
        "rag_docs": rag_titles,
    }


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


@router.get("/personas/{persona_id}/learning-stats")
async def persona_learning_stats(
    persona_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Self-learning stats: rating counts, human-likeness score, recent tips."""
    good = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_messages "
        "WHERE persona_id = ? AND moderator_rating = 'good'",
        [persona_id],
    ).fetchone()["cnt"]

    bad = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_messages "
        "WHERE persona_id = ? AND moderator_rating = 'bad'",
        [persona_id],
    ).fetchone()["cnt"]

    total_rated = good + bad
    human_score = round(good / total_rated, 2) if total_rated else None

    tip_rows = db.execute(
        "SELECT moderator_note FROM tg_ai_messages "
        "WHERE persona_id = ? AND moderator_rating = 'bad' "
        "AND moderator_note IS NOT NULL AND moderator_note != '' "
        "ORDER BY created_at DESC LIMIT 5",
        [persona_id],
    ).fetchall()
    recent_tips = [r["moderator_note"] for r in tip_rows]

    return {
        "total_rated": total_rated,
        "good": good,
        "bad": bad,
        "human_score": human_score,
        "recent_tips": recent_tips,
    }


# ---------------------------------------------------------------------------
# AI Generation
# ---------------------------------------------------------------------------


@router.post("/generate-reply")
async def generate_reply(
    body: GenerateReplyRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Generate an AI reply for a persona based on chat context."""
    persona = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [body.persona_id]
    ).fetchone()
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")

    from app.ai.anthropic_client import generate_message
    from app.tasks.ai_agent_tasks import _resolve_model

    system = persona["system_prompt"] or "You are a helpful chat participant."
    user_msg = (
        f"Chat context:\n{body.chat_context}\n\n"
        f"Message to reply to:\n{body.original_message}\n\n"
        "Generate a natural reply as this persona."
    )

    result = generate_message(
        system_prompt=system,
        user_message=user_msg,
        model=_resolve_model(persona["ai_model"]),
        temperature=persona["temperature"] or 0.8,
    )

    # Save as pending AI message
    msg_id = str(uuid.uuid4())
    now = _now()
    reasoning = (
        f"model={result['model']}, "
        f"tokens={result['tokens_in']}+{result['tokens_out']}"
    )

    try:
        db.execute(
            """INSERT INTO tg_ai_messages
                (id, persona_id, chat_id, original_text, ai_text, ai_reasoning,
                 status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)""",
            [
                msg_id, body.persona_id, body.chat_id or "",
                body.original_message, result["text"], reasoning, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info(
        "ai_reply_generated",
        persona_id=body.persona_id,
        message_id=msg_id,
        model=result["model"],
    )

    return {
        "message_id": msg_id,
        "text": result["text"],
        "model": result["model"],
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
        "cost_usd": result["cost_usd"],
        "status": "PENDING",
    }


# ---------------------------------------------------------------------------
# DM Threads (universal AI-secretary state per account+peer)
# ---------------------------------------------------------------------------

class DMThreadMute(BaseModel):
    muted: bool
    reason: str | None = None


def _row_to_dm_thread(row: Any) -> dict[str, Any]:
    d = dict(row)
    d["muted"] = bool(d.get("muted"))
    return d


@router.get("/dm-threads")
async def list_dm_threads(
    _token: AdminAuth,
    db: WorkspaceDB,
    account_id: str | None = Query(None),
    muted_only: bool = Query(False),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List DM-threads (universal AI-secretary state) for an account, newest first."""
    conds: list[str] = []
    params: list[Any] = []
    if account_id:
        conds.append("account_id = ?")
        params.append(account_id)
    if muted_only:
        conds.append("muted = 1")
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = db.execute(
        f"SELECT * FROM tg_dm_threads {where} "
        f"ORDER BY COALESCE(last_msg_at, updated_at) DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    return {"items": [_row_to_dm_thread(r) for r in rows], "total": len(rows)}


@router.get("/dm-threads/{account_id}/{peer_id}")
async def get_dm_thread(
    account_id: str,
    peer_id: int,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get one DM-thread (account_id, peer_id)."""
    row = db.execute(
        "SELECT * FROM tg_dm_threads WHERE account_id = ? AND peer_id = ?",
        [account_id, peer_id],
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM thread not found")
    return _row_to_dm_thread(row)


@router.post("/dm-threads/{account_id}/{peer_id}/mute")
async def mute_dm_thread(
    account_id: str,
    peer_id: int,
    body: DMThreadMute,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Mute or un-mute the AI-secretary for one DM thread. Idempotent: creates
    the thread row if it doesn't exist yet (operator can pre-silence a peer
    before they even write back)."""
    row = db.execute(
        "SELECT id FROM tg_dm_threads WHERE account_id = ? AND peer_id = ?",
        [account_id, peer_id],
    ).fetchone()
    now = _now()
    muted_int = 1 if body.muted else 0
    if row:
        db.execute(
            "UPDATE tg_dm_threads SET muted=?, mute_reason=?, updated_at=? WHERE id=?",
            [muted_int, body.reason, now, row["id"]],
        )
        db.commit()
        thread_id = row["id"]
    else:
        thread_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO tg_dm_threads "
            "(id, account_id, peer_id, muted, mute_reason, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [thread_id, account_id, peer_id, muted_int, body.reason, now, now],
        )
        db.commit()
    out_row = db.execute(
        "SELECT * FROM tg_dm_threads WHERE id = ?", [thread_id]
    ).fetchone()
    log.info(
        "dm_thread_muted" if body.muted else "dm_thread_unmuted",
        account_id=account_id, peer_id=peer_id,
    )
    return _row_to_dm_thread(out_row)


class DMThreadSummary(BaseModel):
    summary: str


@router.post("/dm-threads/{account_id}/{peer_id}/summary")
async def edit_dm_thread_summary(
    account_id: str,
    peer_id: int,
    body: DMThreadSummary,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Manually overwrite the AI-secretary's summary of a thread.

    Useful when the auto-generated summary missed a key detail the operator
    wants persisted (e.g. timezone, deal stage, do-not-mention topic).
    """
    row = db.execute(
        "SELECT id FROM tg_dm_threads WHERE account_id = ? AND peer_id = ?",
        [account_id, peer_id],
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="DM thread not found")
    db.execute(
        "UPDATE tg_dm_threads SET summary=?, msgs_since_summary=0, updated_at=? WHERE id=?",
        [body.summary, _now(), row["id"]],
    )
    db.commit()
    out_row = db.execute(
        "SELECT * FROM tg_dm_threads WHERE id = ?", [row["id"]]
    ).fetchone()
    return _row_to_dm_thread(out_row)
