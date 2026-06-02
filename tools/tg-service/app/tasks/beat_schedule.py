"""Celery Beat periodic task schedule for TG Service."""

from __future__ import annotations

import json
import uuid

import structlog
from celery import shared_task
from celery.schedules import crontab

log = structlog.get_logger(__name__)


# ── Periodic tasks ───────────────────────────────────────────────────────────


@shared_task(name="pup_tg.beat_heartbeat")
def beat_heartbeat() -> str:
    """One-minute heartbeat -- proves Celery Beat is alive."""
    log.info("beat_heartbeat", status="alive")
    return "beat_heartbeat"


def _iter_workspace_ids() -> list[str]:
    """List workspace ids by scanning the data dir for ``ws-*.db`` files."""
    from app.core.database import _data_dir  # local import: avoid import cycle

    try:
        return sorted(
            p.stem[3:]  # strip "ws-" prefix; ".db" already removed by .stem
            for p in _data_dir().glob("ws-*.db")
            if p.stem.startswith("ws-")
        )
    except Exception:  # noqa: BLE001
        log.warning("reaper_list_workspaces_failed", exc_info=True)
        return []


@shared_task(name="pup_tg.ai_agent_reaper")
def ai_agent_reaper(force: bool = False) -> dict:
    """Revive AI-agent self-loops that died (the loop survives worker restarts).

    The agent loop is self-rescheduling via an ETA task (``apply_async
    countdown=...``). A worker restart drops the pending ETA task, so the chain
    dies silently and an ACTIVE persona stops acting. Two callers use this:

    - ``force=False`` (Beat, every 5 min): revive only ACTIVE personas that have
      gone silent for longer than ``2× scan_interval`` (min 10 min). A healthy
      loop logs a SLEEP every cycle, so its activity age stays under the
      threshold and it is never touched — this avoids re-kicking live loops.
    - ``force=True`` (on ``worker_ready``): revive EVERY ACTIVE persona
      regardless of age. Right after a restart the loop is already dead (its ETA
      task was purged) but its last activity still looks recent, so the age
      check would wrongly skip it — hence the unconditional kick on boot.

    Minting a fresh ``loop_token`` is what makes this safe against duplicate
    loops: if a stale loop were somehow still in flight it carries the OLD token
    and stops on its next tick (token mismatch), leaving exactly one live loop.
    """
    from app.core.database import get_db
    from app.tasks.celery_app import celery_app

    revived: list[str] = []
    checked = 0

    for workspace_id in _iter_workspace_ids():
        try:
            db = get_db(workspace_id)
        except Exception:  # noqa: BLE001
            log.warning("reaper_db_open_failed", workspace_id=workspace_id, exc_info=True)
            continue

        try:
            personas = db.execute(
                "SELECT id, schedule, updated_at FROM tg_ai_personas WHERE status = 'ACTIVE'"
            ).fetchall()
        except Exception:  # noqa: BLE001
            # Workspace DB may predate the personas table — skip quietly.
            continue

        for p in personas:
            checked += 1
            persona_id = p["id"]
            try:
                schedule = json.loads(p["schedule"] or "{}")
            except (ValueError, TypeError):
                schedule = {}
            interval = max(60, min(int(schedule.get("scan_interval_sec", 180)), 3600))
            # Dead-loop threshold: a healthy loop ticks every `interval`, so
            # anything past 2× interval (floor 10 min) means the chain stopped.
            threshold = max(interval * 2, 600)

            # Age (seconds) since the loop last showed life. force=True (boot)
            # presumes the loop is dead (its ETA task was purged) → age=inf so it
            # is always revived; the recent activity row would otherwise mislead.
            if force:
                age: float = float("inf")
            else:
                # julianday parses the ISO/UTC created_at robustly. No activity
                # row yet → fall back to the persona's own update age so we don't
                # race a first cycle that simply hasn't logged anything.
                try:
                    age_row = db.execute(
                        "SELECT (julianday('now') - julianday(MAX(created_at))) * 86400 AS age "
                        "FROM tg_ai_activity WHERE persona_id = ?",
                        [persona_id],
                    ).fetchone()
                    act_age = age_row["age"] if age_row else None
                except Exception:  # noqa: BLE001
                    act_age = None

                if act_age is None:
                    try:
                        upd_row = db.execute(
                            "SELECT (julianday('now') - julianday(updated_at)) * 86400 AS age "
                            "FROM tg_ai_personas WHERE id = ?",
                            [persona_id],
                        ).fetchone()
                        age = upd_row["age"] if upd_row and upd_row["age"] is not None else 1e9
                    except Exception:  # noqa: BLE001
                        age = 1e9
                else:
                    age = act_age

                if age <= threshold:
                    continue  # loop is alive and ticking

            # ── Revive: mint a fresh token, persist, re-dispatch one cycle ──
            new_token = uuid.uuid4().hex
            schedule["loop_token"] = new_token
            try:
                db.execute(
                    "UPDATE tg_ai_personas SET schedule = ? WHERE id = ?",
                    [json.dumps(schedule, ensure_ascii=False), persona_id],
                )
                db.commit()
                celery_app.send_task(
                    "pup_tg.ai_agent",
                    args=[workspace_id, persona_id, new_token],
                    queue="pup_tg_default",
                )
                revived.append(persona_id)
                log.info(
                    "ai_agent_reaper_revived",
                    workspace_id=workspace_id,
                    persona_id=persona_id,
                    age_sec=(-1 if age == float("inf") else int(age)),
                    forced=force,
                    threshold_sec=threshold,
                )
            except Exception:  # noqa: BLE001
                log.warning(
                    "ai_agent_reaper_revive_failed",
                    workspace_id=workspace_id,
                    persona_id=persona_id,
                    exc_info=True,
                )

    if revived:
        log.info("ai_agent_reaper_done", checked=checked, revived=len(revived))
    return {"checked": checked, "revived": revived}


def _norm_chat(chat: str) -> str:
    """Strip t.me/@ prefixes to a bare username/id for entity resolution."""
    s = (chat or "").strip()
    for pre in ("https://t.me/", "http://t.me/", "t.me/", "@"):
        if s.startswith(pre):
            return s[len(pre):]
    return s


@shared_task(name="pup_tg.membership_check")
def membership_check() -> dict:
    """Periodically verify ACTIVE agents are still members of their chats.

    The agent already auto-pauses + notifies when a WRITE fails with a ban, but
    that only fires while it is actively posting. An account can be kicked or
    banned while the agent is idle (silent chat) or resting at its daily limit —
    this catches that case. For each ACTIVE persona it connects every linked
    account and runs ``GetParticipant('me')`` on each target channel; a definite
    Banned / Left / NotParticipant verdict auto-pauses the persona, logs it to
    the activity feed, and DMs the admin.

    Conservative: only DEFINITE ban/kick verdicts pause. NO_PROXY, connect
    errors, and entity-resolve hiccups are skipped (never pause on a transient).
    """
    return _run_async_membership_check()


def _run_async_membership_check() -> dict:
    import asyncio

    return asyncio.run(_membership_check_async())


async def _membership_check_async() -> dict:
    from telethon.errors import UserNotParticipantError
    from telethon.tl.functions.channels import GetParticipantRequest
    from telethon.tl.types import Channel

    from app.core.database import get_db
    from app.core.notify import notify_admin_pref
    from app.tasks.ai_agent_tasks import _log_activity, _now
    from app.telegram.client_pool import disconnect_client, get_client_for_account

    checked = 0
    paused: list[str] = []

    for workspace_id in _iter_workspace_ids():
        try:
            db = get_db(workspace_id)
            personas = db.execute(
                "SELECT id, name, account_ids, target_channels "
                "FROM tg_ai_personas WHERE status = 'ACTIVE'"
            ).fetchall()
        except Exception:  # noqa: BLE001
            continue

        for p in personas:
            try:
                account_ids = json.loads(p["account_ids"] or "[]")
                channels = json.loads(p["target_channels"] or "[]")
            except (ValueError, TypeError):
                continue
            if not account_ids or not channels:
                continue

            checked += 1
            verdict: tuple[str, str] | None = None  # (chat_title, reason)

            for acc_id in account_ids:
                client = None
                try:
                    client = await get_client_for_account(acc_id, db)
                except Exception:  # noqa: BLE001
                    # NO_PROXY / connect error — transient, never pause on it.
                    continue
                try:
                    for chat in channels:
                        try:
                            ent = await client.get_entity(_norm_chat(chat))
                        except Exception:  # noqa: BLE001
                            continue  # resolve hiccup — skip this chat
                        if not isinstance(ent, Channel):
                            continue  # basic group: GetParticipant N/A
                        title = getattr(ent, "title", None) or chat
                        try:
                            pres = await client(GetParticipantRequest(ent, "me"))
                            ptype = type(pres.participant).__name__
                            if "Banned" in ptype or "Left" in ptype:
                                verdict = (title, "забанен/удалён в чате")
                        except UserNotParticipantError:
                            verdict = (title, "больше не участник (кикнут)")
                        if verdict:
                            break
                finally:
                    await disconnect_client(client)
                if verdict:
                    break

            if not verdict:
                continue

            chat_title, reason = verdict
            try:
                db.execute(
                    "UPDATE tg_ai_personas SET status='PAUSED', updated_at=? WHERE id=?",
                    [_now(), p["id"]],
                )
                db.commit()
                _log_activity(
                    db, p["id"], None, None, "SKIP",
                    f"⏸ Авто-пауза (периодическая проверка): аккаунт {reason} "
                    f"«{chat_title}». Разбаньте/верните аккаунт и запустите снова.",
                )
                notify_admin_pref(
                    db, "spam_block",
                    f"🚫 <b>Агент авто-пауза</b> (периодическая проверка членства)\n"
                    f"Персона: {p['name'] or p['id']}\n"
                    f"Чат: {chat_title}\n"
                    f"Причина: аккаунт {reason}"
                )
                paused.append(p["id"])
                log.info("membership_check_paused", persona_id=p["id"], reason=reason)
            except Exception:  # noqa: BLE001
                log.warning("membership_check_pause_failed", persona_id=p["id"], exc_info=True)

    if paused:
        log.info("membership_check_done", checked=checked, paused=len(paused))
    return {"checked": checked, "paused": paused}


# ── Schedule registry ────────────────────────────────────────────────────────

BEAT_SCHEDULE: dict[str, dict[str, object]] = {
    "heartbeat-every-minute": {
        "task": "pup_tg.beat_heartbeat",
        "schedule": 60.0,  # every 60 seconds
        "options": {"queue": "pup_tg_default"},
    },
    "warmup-check-every-hour": {
        "task": "pup_tg.warmup_check",
        "schedule": crontab(minute=0),  # every hour at :00
        "options": {"queue": "pup_tg_default"},
    },
    # Fallback that revives AI-agent self-loops killed by a worker restart.
    "ai-agent-reaper-every-5-min": {
        "task": "pup_tg.ai_agent_reaper",
        "schedule": 300.0,  # every 5 minutes
        "options": {"queue": "pup_tg_default"},
    },
    # Catch agents kicked/banned while idle (write-time detection misses those).
    "membership-check-every-3h": {
        "task": "pup_tg.membership_check",
        "schedule": 10800.0,  # every 3 hours
        "options": {"queue": "pup_tg_default"},
    },
}
