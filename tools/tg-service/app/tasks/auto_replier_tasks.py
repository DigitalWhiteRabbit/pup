"""Celery task for Auto-Replier — monitors incoming DMs and responds.

Polls recent dialogs for unread incoming messages, matches against
trigger rules, generates replies (AI or template), and sends them
with configurable delays.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from app.config import settings
from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    # P5-02: delegate to the shared builder (was duplicated across ~10 modules).
    from app.services.tg_runner import build_proxy_kwargs
    return build_proxy_kwargs(db, proxy_id)



def _connect_account(db: Any, account_id: str) -> dict[str, Any] | None:
    """Load account row, decrypt session, build connection info."""
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'",
        [account_id],
    ).fetchone()
    if not acc:
        return None
    meta = json.loads(acc["metadata"] or "{}")
    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        return None
    session_bytes = decrypt_bytes(Path(acc["session_path"]).read_bytes())
    proxy_kwargs = _build_proxy_kwargs(db, acc["proxy_id"]) if acc["proxy_id"] else {}
    return {
        "account_id": acc["id"],
        "phone": acc["phone"],
        "session_bytes": session_bytes,
        "app_id": int(app_id),
        "app_hash": str(app_hash),
        "twofa": meta.get("twoFA") or meta.get("twofa_password"),
        "proxy_kwargs": proxy_kwargs,
    }


def _is_within_hours(hours_str: str) -> bool:
    """Check if current UTC hour is within active_hours range (e.g. '09:00-22:00')."""
    try:
        parts = hours_str.split("-")
        start_h = int(parts[0].split(":")[0])
        end_h = int(parts[1].split(":")[0])
        current_h = datetime.now(timezone.utc).hour
        if start_h <= end_h:
            return start_h <= current_h < end_h
        else:
            return current_h >= start_h or current_h < end_h
    except Exception:
        return True


def _match_trigger(text: str, triggers: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Match incoming message text against trigger rules.

    Each trigger: {"name": "...", "type": "keyword|regex|any", "pattern": "...", "response": "...", "behavior": "AI_REPLY|TEMPLATE|SILENCE|NOTIFY"}
    Returns the first matching trigger or None.
    """
    text_lower = text.lower().strip()
    for trigger in triggers:
        ttype = trigger.get("type", "keyword")
        pattern = trigger.get("pattern", "")

        if ttype == "any":
            return trigger
        elif ttype == "keyword":
            keywords = [k.strip().lower() for k in pattern.split(",") if k.strip()]
            if any(kw in text_lower for kw in keywords):
                return trigger
        elif ttype == "regex":
            try:
                if re.search(pattern, text, re.IGNORECASE):
                    return trigger
            except re.error:
                pass

    return None


# Interval between auto-replier cycles while the scenario stays ACTIVE.
_RESCHEDULE_SECONDS = 90


@celery_app.task(name="pup_tg.auto_replier", bind=True, max_retries=0)
def auto_replier(self, workspace_id: str, scenario_id: str) -> dict:
    """Execute auto-replier scenario — monitor DMs and respond.

    Self-reschedules while the scenario is still ``ACTIVE`` in this
    workspace so incoming DMs keep being processed. Stops naturally once
    the scenario is paused/removed.
    """
    result = asyncio.run(_auto_replier_async(workspace_id, scenario_id))

    # Self-reschedule only while the scenario is still ACTIVE.
    try:
        db = get_db(workspace_id)
        row = db.execute(
            "SELECT status FROM tg_auto_replier_scenarios WHERE id = ?",
            [scenario_id],
        ).fetchone()
        if row and row["status"] == "ACTIVE":
            self.apply_async(
                args=[workspace_id, scenario_id],
                countdown=_RESCHEDULE_SECONDS,
                queue="pup_tg_default",
            )
            log.info(
                "auto_replier_rescheduled",
                scenario_id=scenario_id,
                countdown=_RESCHEDULE_SECONDS,
            )
        else:
            log.info("auto_replier_stopped", scenario_id=scenario_id)
    except Exception:
        log.warning(
            "auto_replier_reschedule_failed", scenario_id=scenario_id, exc_info=True
        )

    return result


async def _auto_replier_async(workspace_id: str, scenario_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # Load scenario
    scenario = db.execute(
        "SELECT * FROM tg_auto_replier_scenarios WHERE id = ?",
        [scenario_id],
    ).fetchone()
    if not scenario:
        return {"status": "FAILED", "error": "Scenario not found"}
    if scenario["status"] != "ACTIVE":
        return {"status": "SKIPPED", "error": f"Scenario status is {scenario['status']}"}

    triggers = json.loads(scenario["triggers"] or "[]")
    default_behavior = scenario["default_behavior"] or "AI_REPLY"
    active_hours = scenario["active_hours"] or "09:00-22:00"
    delay_min = scenario["delay_min"] or 5
    delay_max = scenario["delay_max"] or 45
    account_ids = json.loads(scenario["account_ids"] or "[]")

    if not _is_within_hours(active_hours):
        return {"status": "SKIPPED", "reason": "Outside active hours"}

    # Pick accounts
    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]
    if not account_ids:
        return {"status": "FAILED", "error": "No active accounts"}

    log.info(
        "auto_replier_started",
        scenario_id=scenario_id,
        workspace_id=workspace_id,
        accounts=len(account_ids),
        triggers=len(triggers),
    )

    total_replies = 0
    total_skipped = 0

    for acc_id in account_ids:
        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, scenario_id=scenario_id)
            total_skipped += 1
            continue

        tmp_dir = tempfile.mkdtemp(prefix="autorep_")
        tmp_session = Path(tmp_dir) / "autorep.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            FloodWaitError,
            PeerFloodError,
            UserPrivacyRestrictedError,
            AuthKeyUnregisteredError,
            UserDeactivatedBanError,
        )

        client = TelegramClient(
            str(tmp_session.with_suffix("")),
            acc_info["app_id"], acc_info["app_hash"],
            timeout=30, connection_retries=3,
            **acc_info["proxy_kwargs"],
        )

        try:
            await client.connect()
            if not await client.is_user_authorized():
                if acc_info["twofa"]:
                    await client.sign_in(password=str(acc_info["twofa"]))
                else:
                    continue
        except AuthKeyUnregisteredError:
            db.execute(
                "UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                [_now(), acc_id],
            )
            db.commit()
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            continue
        except Exception as e:
            log.error("auto_replier_connect_error", account_id=acc_id, error=str(e)[:100])
            continue

        # Get recent dialogs with unread messages
        try:
            dialogs = await client.get_dialogs(limit=30)
        except Exception as e:
            log.error("auto_replier_dialogs_error", error=str(e)[:200])
            await client.disconnect()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue

        for dialog in dialogs:
            if dialog.unread_count == 0:
                continue
            # Only handle private chats (DMs)
            if not dialog.is_user:
                continue

            # Get unread messages
            try:
                messages = await client.get_messages(dialog.entity, limit=dialog.unread_count)
            except Exception:
                continue

            for msg in reversed(messages):  # oldest first
                if msg.out:  # skip our own messages
                    continue
                if not msg.text:
                    continue

                # Check if already replied to this message
                existing = db.execute(
                    "SELECT id FROM tg_auto_replies WHERE scenario_id = ? AND inbound_text = ? AND account_id = ?",
                    [scenario_id, msg.text[:500], acc_id],
                ).fetchone()
                if existing:
                    continue

                # Match trigger
                matched_trigger = _match_trigger(msg.text, triggers)
                behavior = matched_trigger["behavior"] if matched_trigger else default_behavior
                trigger_name = matched_trigger["name"] if matched_trigger else "default"

                if behavior == "SILENCE":
                    total_skipped += 1
                    continue

                if behavior == "NOTIFY":
                    # Just log, don't reply
                    db.execute(
                        """INSERT INTO tg_auto_replies
                            (id, scenario_id, account_id, trigger_name, inbound_text, response_text, delay_used_sec, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        [str(uuid.uuid4()), scenario_id, acc_id, trigger_name,
                         msg.text[:500], "[NOTIFY ONLY]", 0, _now()],
                    )
                    db.commit()
                    total_skipped += 1
                    continue

                # Generate reply
                reply_text = ""
                if behavior == "TEMPLATE" and matched_trigger:
                    reply_text = matched_trigger.get("response", "")
                elif behavior == "AI_REPLY":
                    try:
                        from app.ai.anthropic_client import generate_message
                        ai_result = generate_message(
                            system_prompt=(
                                "You are a friendly Telegram assistant. "
                                "Reply naturally and concisely in the same language as the incoming message. "
                                "Keep replies under 200 characters."
                            ),
                            user_message=f"Incoming DM: {msg.text[:1000]}",
                            model="claude-haiku-4-5-20251001",
                            max_tokens=200,
                            temperature=0.8,
                        )
                        reply_text = ai_result["text"]
                    except Exception as e:
                        log.error("auto_replier_ai_error", error=str(e)[:200])
                        continue
                elif behavior == "HANDOFF_SALES":
                    # Log for sales team pickup
                    reply_text = ""

                if not reply_text:
                    total_skipped += 1
                    continue

                # Delay before sending
                delay = random.uniform(delay_min, delay_max)
                log.info("auto_replier_delay", seconds=round(delay, 1))
                await asyncio.sleep(delay)

                # Send reply
                try:
                    await client.send_message(dialog.entity, reply_text)

                    db.execute(
                        """INSERT INTO tg_auto_replies
                            (id, scenario_id, account_id, trigger_name, inbound_text, response_text, delay_used_sec, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        [str(uuid.uuid4()), scenario_id, acc_id, trigger_name,
                         msg.text[:500], reply_text[:1000], int(delay), _now()],
                    )
                    db.commit()

                    total_replies += 1
                    log.info(
                        "auto_replier_sent",
                        account=acc_info["phone"],
                        trigger=trigger_name,
                        behavior=behavior,
                    )

                    # Update scenario counter
                    db.execute(
                        "UPDATE tg_auto_replier_scenarios SET total_replies = total_replies + 1, updated_at = ? WHERE id = ?",
                        [_now(), scenario_id],
                    )
                    db.commit()

                except UserPrivacyRestrictedError:
                    total_skipped += 1
                except FloodWaitError as e:
                    log.warning("auto_replier_flood", wait=e.seconds)
                    if e.seconds > 300:
                        db.execute(
                            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                            [_now(), acc_id],
                        )
                        db.commit()
                        break
                    await asyncio.sleep(e.seconds + 5)
                except PeerFloodError:
                    db.execute(
                        "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                        [_now(), acc_id],
                    )
                    db.commit()
                    break
                except Exception as e:
                    log.warning("auto_replier_send_error", error=str(e)[:200])

            # Mark dialog as read
            try:
                await client.send_read_acknowledge(dialog.entity)
            except Exception:
                pass

        # Disconnect
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "auto_replier.cycle", "INFO", "auto_replier", scenario_id,
            f"Auto-replier cycle: {total_replies} replied, {total_skipped} skipped",
            json.dumps({"replies": total_replies, "skipped": total_skipped}),
            _now(),
        ],
    )
    db.commit()

    result = {
        "status": "COMPLETED",
        "replies": total_replies,
        "skipped": total_skipped,
    }
    log.info("auto_replier_complete", scenario_id=scenario_id, **result)
    return result
