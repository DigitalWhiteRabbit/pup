"""Agent Arena — multi-agent self-play in a real TG group → training corpus.

CRUD for arenas plus a read-only ``/verify`` that resolves the group and checks
which persona accounts are actually members. The live conversation cycle
(``arena_tick``) and corpus harvesting land in later phases — this module is the
foundation (data + management API). See ARENA_SPEC.md.
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

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/arenas", tags=["arena"])

_VALID_MODES = {"casual", "sales"}
_VALID_STATUS = {"DRAFT", "RUNNING", "PAUSED", "STOPPED"}

# JSON columns deserialized on the way out / serialized on the way in.
_JSON_FIELDS = ("persona_ids", "sales_config", "turn_order")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ArenaCreate(BaseModel):
    name: str
    chat_id: str | None = None
    chat_title: str | None = None
    persona_ids: list[str] = Field(default_factory=list)
    mode: str = "casual"  # casual | sales
    topic: str | None = None
    sales_config: dict[str, Any] | None = None
    cadence_sec: int = Field(default=120, ge=15)
    max_msgs_day: int = Field(default=100, ge=1)


class ArenaUpdate(BaseModel):
    name: str | None = None
    chat_id: str | None = None
    chat_title: str | None = None
    persona_ids: list[str] | None = None
    mode: str | None = None
    topic: str | None = None
    sales_config: dict[str, Any] | None = None
    cadence_sec: int | None = Field(default=None, ge=15)
    max_msgs_day: int | None = Field(default=None, ge=1)
    status: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_arena(row: Any) -> dict[str, Any]:
    """Convert a raw SQLite row into an API dict, deserializing JSON columns."""
    data = dict(row)
    for field in _JSON_FIELDS:
        raw = data.get(field)
        if raw:
            try:
                data[field] = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                data[field] = None
        else:
            data[field] = None
    if data.get("persona_ids") is None:
        data["persona_ids"] = []
    if data.get("turn_order") is None:
        data["turn_order"] = []
    return data


def _normalize_chat_ref(raw: str) -> str | int:
    """Normalize a group reference for Telethon get_entity.

    Accepts @username, t.me links, numeric ids (incl. -100… supergroup ids).
    Private invite links (t.me/+hash, joinchat) are returned as-is — the
    account must already be a member for resolution to succeed.
    """
    ref = (raw or "").strip()
    for prefix in ("https://t.me/", "http://t.me/", "t.me/"):
        if ref.lower().startswith(prefix):
            ref = ref[len(prefix):]
            break
    if ref.startswith("@"):
        ref = ref[1:]
    # Plain numeric id (supergroup -100... or chat id)
    bare = ref.lstrip("-")
    if bare.isdigit():
        try:
            return int(ref)
        except ValueError:
            return ref
    return ref


def _persona_accounts(db: Any, persona_ids: list[str]) -> list[dict[str, Any]]:
    """Resolve persona_ids → [{persona_id, name, account_ids[]}]."""
    out: list[dict[str, Any]] = []
    for pid in persona_ids:
        prow = db.execute(
            "SELECT id, name, account_ids FROM tg_ai_personas WHERE id = ?", [pid]
        ).fetchone()
        if not prow:
            out.append({"persona_id": pid, "name": "(удалена)", "account_ids": []})
            continue
        try:
            acc_ids = json.loads(prow["account_ids"] or "[]")
        except (json.JSONDecodeError, TypeError):
            acc_ids = []
        out.append({"persona_id": pid, "name": prow["name"], "account_ids": acc_ids})
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("")
async def list_arenas(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
) -> dict[str, Any]:
    """List all arenas (most recent first)."""
    if status_filter:
        rows = db.execute(
            "SELECT * FROM tg_agent_arenas WHERE status = ? ORDER BY created_at DESC",
            [status_filter],
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM tg_agent_arenas ORDER BY created_at DESC"
        ).fetchall()
    return {"items": [_row_to_arena(r) for r in rows], "total": len(rows)}


@router.get("/{arena_id}")
async def get_arena(
    arena_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single arena by id."""
    row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Arena not found")
    return _row_to_arena(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_arena(
    body: ArenaCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new arena (status=DRAFT)."""
    if body.mode not in _VALID_MODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid mode '{body.mode}'. Must be one of: {', '.join(sorted(_VALID_MODES))}",
        )
    if len(body.persona_ids) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Нужно минимум 2 персоны для арены",
        )
    if len(body.persona_ids) > 4:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Максимум 4 персоны на арену",
        )

    arena_id = str(uuid.uuid4())
    now = _now()
    # Default turn order = persona order as given.
    turn_order = list(body.persona_ids)

    try:
        db.execute(
            """INSERT INTO tg_agent_arenas
                (id, name, chat_id, chat_title, persona_ids, mode, topic,
                 sales_config, cadence_sec, max_msgs_day, turn_order,
                 next_turn_idx, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT', ?, ?)""",
            [
                arena_id, body.name, body.chat_id, body.chat_title,
                json.dumps(body.persona_ids), body.mode, body.topic,
                json.dumps(body.sales_config) if body.sales_config else None,
                body.cadence_sec, body.max_msgs_day, json.dumps(turn_order),
                now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    log.info("arena_created", arena_id=arena_id, mode=body.mode, personas=len(body.persona_ids))
    return _row_to_arena(row)


@router.patch("/{arena_id}")
async def update_arena(
    arena_id: str,
    body: ArenaUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update arena fields. Only provided (non-None) fields are changed."""
    existing = db.execute(
        "SELECT id FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Arena not found")

    fields = body.model_dump(exclude_unset=True)
    if "mode" in fields and fields["mode"] not in _VALID_MODES:
        raise HTTPException(status_code=400, detail=f"Invalid mode '{fields['mode']}'")
    if "status" in fields and fields["status"] not in _VALID_STATUS:
        raise HTTPException(status_code=400, detail=f"Invalid status '{fields['status']}'")
    if "persona_ids" in fields:
        pids = fields["persona_ids"] or []
        if not (2 <= len(pids) <= 4):
            raise HTTPException(status_code=400, detail="Нужно 2–4 персоны")

    updates: dict[str, Any] = {}
    for key, value in fields.items():
        if key in ("persona_ids", "sales_config"):
            updates[key] = json.dumps(value) if value is not None else None
        else:
            updates[key] = value

    # Keep turn_order in sync when personas change.
    if "persona_ids" in fields and fields["persona_ids"]:
        updates["turn_order"] = json.dumps(list(fields["persona_ids"]))
        updates["next_turn_idx"] = 0

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates["updated_at"] = _now()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [arena_id]

    try:
        db.execute(f"UPDATE tg_agent_arenas SET {set_clause} WHERE id = ?", values)
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    return _row_to_arena(row)


@router.delete("/{arena_id}")
async def delete_arena(
    arena_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Delete an arena. Does not touch the TG group or harvested corpus."""
    existing = db.execute(
        "SELECT id FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Arena not found")
    try:
        db.execute("DELETE FROM tg_agent_arenas WHERE id = ?", [arena_id])
        db.commit()
    except Exception:
        db.rollback()
        raise
    log.info("arena_deleted", arena_id=arena_id)
    return {"status": "deleted", "id": arena_id}


@router.post("/{arena_id}/start")
async def start_arena(
    arena_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Move arena to RUNNING and kick the self-rescheduling ``arena_tick`` loop.

    A fresh ``loop_token`` is minted on every start: any in-flight tick left
    over from a previous start carries the OLD token and dies on its next
    reschedule (no duplicate loops). Idempotent: starting a RUNNING arena
    rotates the token (useful as a heal-after-restart kick).
    """
    arena_row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not arena_row:
        raise HTTPException(status_code=404, detail="Arena not found")
    arena = _row_to_arena(arena_row)

    if not arena.get("chat_id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="У арены не указана группа (chat_id)",
        )
    persona_ids = arena.get("persona_ids") or []
    if len(persona_ids) < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Добавь хотя бы одну персону в арену",
        )

    # Default turn_order = persona_ids in declaration order. Operator can
    # override later via update endpoint.
    turn_order = arena.get("turn_order") or persona_ids

    loop_token = str(uuid.uuid4())

    try:
        db.execute(
            "UPDATE tg_agent_arenas "
            "SET status='RUNNING', loop_token=?, turn_order=?, updated_at=? "
            "WHERE id=?",
            [loop_token, json.dumps(turn_order), _now(), arena_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Kick the loop. Celery is best-effort here: if the broker is down the
    # status is RUNNING but no tick fires — the next start (or a reaper added
    # in Phase 5) revives it.
    kicked = False
    try:
        from app.tasks.arena_tasks import arena_tick

        arena_tick.apply_async(
            args=[workspace_id, arena_id, loop_token],
            countdown=0,
            queue="pup_tg_default",
        )
        kicked = True
        log.info("arena_started", arena_id=arena_id, loop_token=loop_token[:8])
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "arena_start_dispatch_failed", arena_id=arena_id, error=str(exc)[:160]
        )

    return {"status": "RUNNING", "id": arena_id, "loop_token": loop_token, "kicked": kicked}


@router.post("/{arena_id}/stop")
async def stop_arena(
    arena_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Move arena to STOPPED. The next ``arena_tick`` sees ``status != RUNNING``
    and stops rescheduling — the loop dies on its own within one cadence.
    Also rotates ``loop_token`` so an in-flight tick can't resurrect it."""
    existing = db.execute(
        "SELECT id FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Arena not found")
    try:
        db.execute(
            "UPDATE tg_agent_arenas SET status='STOPPED', loop_token=?, updated_at=? WHERE id=?",
            [str(uuid.uuid4()), _now(), arena_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    log.info("arena_stopped", arena_id=arena_id)
    return {"status": "STOPPED", "id": arena_id}


@router.post("/{arena_id}/verify")
async def verify_arena(
    arena_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Resolve the arena's TG group and check which persona accounts are members.

    Read-only pre-flight: connects one account to resolve the group, then each
    persona account to run GetParticipant('me'). Updates ``chat_title``.
    """
    arena_row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not arena_row:
        raise HTTPException(status_code=404, detail="Arena not found")
    arena = _row_to_arena(arena_row)

    if not arena.get("chat_id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="У арены не указана группа (chat_id/ссылка)",
        )

    from telethon.tl.functions.channels import GetParticipantRequest

    from app.telegram.client_pool import (
        disconnect_client,
        get_any_client,
        get_client_for_account,
    )

    chat_ref = _normalize_chat_ref(arena["chat_id"])
    personas = _persona_accounts(db, arena.get("persona_ids") or [])

    # 1. Resolve group via any active client.
    chat_title = arena.get("chat_title")
    members_count = None
    resolve_client = None
    try:
        resolve_client = await get_any_client(db)
        entity = await resolve_client.get_entity(chat_ref)
        chat_title = getattr(entity, "title", None) or chat_title
        members_count = getattr(entity, "participants_count", None)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("arena_verify_resolve_failed", arena_id=arena_id, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Не удалось найти группу '{arena['chat_id']}': {exc}",
        )
    finally:
        if resolve_client is not None:
            await disconnect_client(resolve_client)

    # 2. Per-account membership via each account's own client.
    persona_results: list[dict[str, Any]] = []
    for p in personas:
        acc_status: list[dict[str, Any]] = []
        for acc_id in p["account_ids"]:
            acc_row = db.execute(
                "SELECT phone FROM tg_accounts WHERE id = ?", [acc_id]
            ).fetchone()
            phone = acc_row["phone"] if acc_row else acc_id
            in_group = False
            err: str | None = None
            client = None
            try:
                client = await get_client_for_account(acc_id, db)
                ent = await client.get_entity(chat_ref)
                try:
                    await client(GetParticipantRequest(ent, "me"))
                    in_group = True
                except Exception:
                    in_group = False
            except HTTPException as he:
                err = he.detail if isinstance(he.detail, str) else "connect error"
            except Exception as exc:  # noqa: BLE001
                err = str(exc)[:120]
            finally:
                if client is not None:
                    await disconnect_client(client)
            acc_status.append(
                {"account_id": acc_id, "phone": phone, "in_group": in_group, "error": err}
            )
        persona_results.append(
            {"persona_id": p["persona_id"], "name": p["name"], "accounts": acc_status}
        )

    # Persist resolved title.
    if chat_title and chat_title != arena.get("chat_title"):
        try:
            db.execute(
                "UPDATE tg_agent_arenas SET chat_title = ?, updated_at = ? WHERE id = ?",
                [chat_title, _now(), arena_id],
            )
            db.commit()
        except Exception:
            db.rollback()

    all_in = all(
        a["in_group"]
        for pr in persona_results
        for a in pr["accounts"]
    ) and any(pr["accounts"] for pr in persona_results)

    return {
        "chat_title": chat_title,
        "members_count": members_count,
        "all_members_present": all_in,
        "personas": persona_results,
    }
