"""Agent Arena — multi-agent self-play cycle (Phase 2: casual mode).

Heart of the arena: a Celery task that runs one persona's turn in the
configured TG group every ``cadence_sec`` seconds, then self-reschedules
while ``status='RUNNING'`` and ``loop_token`` still matches.

Casual-mode generation reuses the existing ``_generate_opener`` from
``ai_agent_tasks`` (on-topic, no Atlas/RAG, _humanize_text post-processed)
so the arena starts speaking immediately without a parallel codebase.

Anti-ban:
- FloodWait / banned / write-forbidden → arena → PAUSED + notify.
- Per-arena daily cap counted from ``tg_ai_messages.arena_id``.
- Global monthly AI budget gate via ``_check_ai_budget``.
- Turn jitter so 2-4 bots do not post in lockstep.

Loop guarantees: cycle exceptions are caught and the loop still reschedules
(a transient blip must not kill a RUNNING arena). The loop_token nonce —
minted by ``POST /arenas/{id}/start`` — guards against duplicate loops left
behind by restarts or a second start race.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.database import get_db
from app.core.notify import notify_admin
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_entity_ref(chat_ref: str) -> Any:
    """Coerce arena.chat_id into a Telethon-friendly entity reference."""
    ref = (chat_ref or "").strip()
    if not ref:
        return ref
    # numeric (incl. -100… supergroup ids) → int for Telethon
    bare = ref.lstrip("-")
    if bare.isdigit():
        try:
            return int(ref)
        except ValueError:
            return ref
    return ref


# ══════════════════════════════════════════════════════════════════════════
# Celery task entry point
# ══════════════════════════════════════════════════════════════════════════

@celery_app.task(name="pup_tg.arena_tick", bind=True, max_retries=0)
def arena_tick(
    self,
    workspace_id: str,
    arena_id: str,
    loop_token: str | None = None,
) -> dict:
    """Run one arena turn, then self-reschedule while RUNNING.

    Cycle errors never break the loop — they are logged and a new tick is
    still queued (mirrors the ai_agent loop). The token guard ensures a
    stale tick left over from a previous start dies quietly.
    """
    try:
        result = asyncio.run(_arena_tick_async(workspace_id, arena_id))
    except Exception as exc:  # noqa: BLE001
        log.warning("arena_tick_failed", arena_id=arena_id, exc_info=True)
        result = {"status": "ERROR", "error": str(exc)[:200]}

    try:
        db = get_db(workspace_id)
        row = db.execute(
            "SELECT status, loop_token, cadence_sec FROM tg_agent_arenas WHERE id = ?",
            [arena_id],
        ).fetchone()
        if row and row["status"] == "RUNNING":
            if loop_token is None or row["loop_token"] == loop_token:
                cadence = max(15, min(int(row["cadence_sec"] or 120), 3600))
                # ±20% jitter so multiple personas/arenas don't fire in lockstep.
                jitter = random.uniform(-0.2, 0.2) * cadence
                countdown = max(5, int(cadence + jitter))
                arena_tick.apply_async(
                    args=[workspace_id, arena_id, loop_token],
                    countdown=countdown,
                    queue="pup_tg_default",
                )
                log.info(
                    "arena_tick_rescheduled", arena_id=arena_id, countdown=countdown
                )
            else:
                log.info("arena_tick_loop_superseded", arena_id=arena_id)
    except Exception:  # noqa: BLE001
        log.warning("arena_tick_reschedule_failed", arena_id=arena_id, exc_info=True)

    return result


# ══════════════════════════════════════════════════════════════════════════
# One arena turn
# ══════════════════════════════════════════════════════════════════════════

async def _arena_tick_async(workspace_id: str, arena_id: str) -> dict:
    """Execute one round-robin turn for the arena (casual mode)."""
    from telethon.errors import (
        AuthKeyUnregisteredError,
        ChatWriteForbiddenError,
        FloodWaitError,
        PeerFloodError,
        UserBannedInChannelError,
        UserDeactivatedBanError,
    )

    # Lazy import: ai_agent_tasks defines the heavy helpers (Telethon client,
    # opener generation, budget). Re-using them keeps generation parity and
    # avoids duplicating ~200 lines.
    from app.tasks.ai_agent_tasks import (
        _check_ai_budget,
        _connect_account_info,
        _generate_opener,
        _human_pause,
        _make_client,
        _resilient_send,
        _resolve_model,
        _track_ai_cost,
    )

    db = get_db(workspace_id)

    arena_row = db.execute(
        "SELECT * FROM tg_agent_arenas WHERE id = ?", [arena_id]
    ).fetchone()
    if not arena_row:
        return {"status": "SKIPPED", "error": "arena not found"}
    arena = dict(arena_row)
    if arena["status"] != "RUNNING":
        return {"status": "SKIPPED", "error": f"arena status is {arena['status']}"}

    chat_ref = arena.get("chat_id")
    if not chat_ref:
        return {"status": "SKIPPED", "error": "arena has no chat_id"}

    persona_ids = json.loads(arena.get("persona_ids") or "[]")
    turn_order = json.loads(arena.get("turn_order") or "[]") or persona_ids
    if not turn_order:
        return {"status": "SKIPPED", "error": "no personas in arena"}

    # ── Daily cap ──────────────────────────────────────────────────────
    max_msgs_day = int(arena.get("max_msgs_day") or 100)
    today_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    sent_today_row = db.execute(
        "SELECT COUNT(*) AS c FROM tg_ai_messages "
        "WHERE arena_id = ? AND created_at >= ?",
        [arena_id, today_start],
    ).fetchone()
    sent_today = sent_today_row["c"] if sent_today_row else 0
    if sent_today >= max_msgs_day:
        log.info("arena_daily_limit", arena_id=arena_id, limit=max_msgs_day)
        return {"status": "SKIPPED", "error": f"daily limit reached ({max_msgs_day})"}

    # ── Budget gate ────────────────────────────────────────────────────
    if not _check_ai_budget(db):
        log.warning("arena_budget_exceeded", arena_id=arena_id)
        return {"status": "SKIPPED", "error": "AI monthly budget exceeded"}

    # ── Pick persona by round-robin ────────────────────────────────────
    idx = int(arena.get("next_turn_idx") or 0) % len(turn_order)
    persona_id = turn_order[idx]

    persona_row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not persona_row:
        _advance_turn(db, arena_id, idx, len(turn_order))
        return {"status": "SKIPPED", "error": f"persona {persona_id} not found"}
    persona = dict(persona_row)

    account_ids = json.loads(persona.get("account_ids") or "[]")
    if not account_ids:
        _advance_turn(db, arena_id, idx, len(turn_order))
        return {"status": "SKIPPED", "error": f"persona {persona_id} has no accounts"}

    # First account for the persona. (Multi-account rotation is a Phase 5
    # enhancement — for mini-version we pick the first ACTIVE one we can
    # connect.)
    acc_info = None
    for acc_id in account_ids:
        info = _connect_account_info(db, acc_id)
        if info and "proxy" in info.get("proxy_kwargs", {}):
            acc_info = info
            break
    if not acc_info:
        _advance_turn(db, arena_id, idx, len(turn_order))
        return {
            "status": "SKIPPED",
            "error": f"no ACTIVE+proxy account for persona {persona_id}",
        }

    chat_title = arena.get("chat_title") or str(chat_ref)
    entity_ref = _normalize_entity_ref(str(chat_ref))

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _make_client(acc_info)

        own_username = None
        own_name = None
        try:
            me = await client.get_me()
            if me:
                own_username = (me.username or "").lower() or None
                own_name = (me.first_name or "").strip() or None
        except Exception:  # noqa: BLE001
            pass

        # Resolve group entity
        try:
            entity = await client.get_entity(entity_ref)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "arena_resolve_failed",
                arena_id=arena_id, chat_ref=str(chat_ref), error=str(exc)[:160],
            )
            _advance_turn(db, arena_id, idx, len(turn_order))
            return {"status": "ERROR", "error": f"resolve failed: {str(exc)[:120]}"}

        real_chat_id = str(entity.id)

        # Read recent context (compact — opener only needs the gist)
        recent_context: list[str] = []
        try:
            msgs = []
            async for m in client.iter_messages(entity, limit=15):
                msgs.append(m)
            for m in reversed(msgs):
                if not m.text:
                    continue
                sender_name = ""
                if m.sender:
                    sender_name = getattr(m.sender, "first_name", "") or ""
                    if hasattr(m.sender, "username") and m.sender.username:
                        sender_name = f"@{m.sender.username}"
                recent_context.append(f"[{sender_name}]: {m.text[:200]}")
        except Exception:  # noqa: BLE001
            log.debug("arena_read_context_failed", arena_id=arena_id, exc_info=True)

        # Casual generation. Pass arena.topic as chat_about so the opener
        # respects the seed scenario when one is set.
        model = _resolve_model(persona.get("ai_model"))
        temperature = float(persona.get("temperature") or 0.8)
        topic_hint = arena.get("topic") or ""

        text, cost = await _generate_opener(
            persona,
            chat_title,
            topic_hint,
            recent_context,
            model,
            temperature,
            own_name=own_name,
            own_username=own_username,
        )
        if not text:
            _advance_turn(db, arena_id, idx, len(turn_order))
            return {"status": "SKIPPED", "error": "generation produced empty text"}

        # Human-feeling pause + send
        delay = random.uniform(8, 30)
        try:
            await _human_pause(client, entity, delay)
            sent_msg = await _resilient_send(client, entity, text)
        except FloodWaitError as e:
            _pause_arena(db, arena_id, f"FloodWait {e.seconds}s")
            return {"status": "PAUSED", "error": f"flood_wait {e.seconds}s"}
        except (UserBannedInChannelError, ChatWriteForbiddenError) as e:
            _pause_arena(db, arena_id, f"banned/forbidden: {type(e).__name__}")
            return {"status": "PAUSED", "error": "banned_or_forbidden"}
        except PeerFloodError:
            _pause_arena(db, arena_id, "PeerFlood (spam guard)")
            return {"status": "PAUSED", "error": "peer_flood"}
        except (AuthKeyUnregisteredError, UserDeactivatedBanError):
            # Account-level death: pause arena so operator can swap the account.
            _pause_arena(db, arena_id, "account dead/banned")
            return {"status": "PAUSED", "error": "account_dead_or_banned"}

        tg_message_id = sent_msg.id if sent_msg else None
        _track_ai_cost(db, cost)

        # Log to tg_ai_messages with arena_id (so harvest in Phase 4 can grab it)
        db.execute(
            """
            INSERT INTO tg_ai_messages
              (id, persona_id, chat_id, chat_title, reply_to_msg_id,
               original_text, ai_text, ai_reasoning,
               status, sent_at, tg_message_id, created_at, arena_id)
            VALUES (?, ?, ?, ?, NULL, '', ?, ?, 'SENT', ?, ?, ?, ?)
            """,
            [
                str(uuid.uuid4()), persona_id, real_chat_id, chat_title,
                text, f"arena casual cost=${cost:.4f}",
                _now(), tg_message_id, _now(), arena_id,
            ],
        )
        # Activity log (so the AI agent monitor shows arena turns too)
        try:
            db.execute(
                "INSERT INTO tg_ai_activity "
                "(id, persona_id, chat_id, chat_title, kind, message, meta, created_at) "
                "VALUES (?, ?, ?, ?, 'SENT', ?, ?, ?)",
                [
                    str(uuid.uuid4()), persona_id, real_chat_id, chat_title,
                    f"🎭 Арена «{arena.get('name','')}»: «{text[:160]}»",
                    json.dumps(
                        {"arena_id": arena_id, "tg_message_id": tg_message_id},
                        ensure_ascii=False,
                    ),
                    _now(),
                ],
            )
        except Exception:  # noqa: BLE001
            log.debug("arena_activity_log_failed", arena_id=arena_id, exc_info=True)

        # Advance turn + counters
        new_idx = (idx + 1) % len(turn_order)
        db.execute(
            "UPDATE tg_agent_arenas "
            "SET next_turn_idx=?, total_msgs=total_msgs+1, updated_at=? "
            "WHERE id=?",
            [new_idx, _now(), arena_id],
        )
        db.commit()

        log.info(
            "arena_tick_sent", arena_id=arena_id, persona_id=persona_id,
            chat_id=real_chat_id, len=len(text),
        )
        return {
            "status": "SENT",
            "persona_id": persona_id,
            "tg_message_id": tg_message_id,
            "cost_usd": cost,
        }

    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        if tmp_dir is not None:
            try:
                shutil.rmtree(str(tmp_dir), ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass


# ══════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════

def _advance_turn(db: Any, arena_id: str, idx: int, total: int) -> None:
    """Bump next_turn_idx even when we skipped this turn — otherwise a
    persistently misconfigured persona would block the whole round-robin."""
    if total <= 0:
        return
    try:
        db.execute(
            "UPDATE tg_agent_arenas SET next_turn_idx=?, updated_at=? WHERE id=?",
            [(idx + 1) % total, _now(), arena_id],
        )
        db.commit()
    except Exception:  # noqa: BLE001
        log.debug("arena_advance_turn_failed", arena_id=arena_id, exc_info=True)


def _pause_arena(db: Any, arena_id: str, reason: str) -> None:
    """Move arena to PAUSED and notify admin. Loop dies on the next reschedule."""
    try:
        db.execute(
            "UPDATE tg_agent_arenas SET status='PAUSED', updated_at=? WHERE id=?",
            [_now(), arena_id],
        )
        db.commit()
    except Exception:  # noqa: BLE001
        log.warning("arena_pause_db_failed", arena_id=arena_id, exc_info=True)
    try:
        notify_admin(f"🎭 Арена приостановлена ({arena_id[:8]}): {reason}")
    except Exception:  # noqa: BLE001
        log.debug("arena_pause_notify_failed", arena_id=arena_id, exc_info=True)
