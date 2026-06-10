"""Celery task for executing warmup scripts on multiple accounts.

Connects to Telegram via Telethon, runs the user-defined action list
(subscribe, react, comment, read_chats, view_stories) per account,
logs results to tg_warmup_runs and tg_warmup_actions.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# Generic short comments for the "comment" action when no text is specified
GENERIC_COMMENTS = [
    "\U0001f44d",       # thumbs up
    "\U0001f525",       # fire
    "\U0001f4af",       # 100
    "\U0001f60a",       # smile
    "\u2764\ufe0f",     # heart
    "+",
    "\U0001f44f",       # clap
    "\U0001f929",       # star eyes
    "\U0001f6a8",       # siren
    "Nice!",
    "Cool",
    "\U0001f4aa",       # flex
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    # P5-02: delegate to the shared builder (was duplicated across ~10 modules).
    from app.services.tg_runner import build_proxy_kwargs
    return build_proxy_kwargs(db, proxy_id)



def _connect_account_info(db: Any, account_id: str) -> dict[str, Any] | None:
    """Load account row, decrypt session, build connection info."""
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not acc:
        return None
    if acc["status"] not in ("ACTIVE", "WARMING"):
        log.warning("warmup_script_skip_account", account_id=account_id,
                     reason=f"status={acc['status']}")
        return None

    meta = json.loads(acc["metadata"] or "{}")
    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        return None

    session_path = Path(acc["session_path"])
    if not session_path.exists():
        return None

    session_bytes = decrypt_bytes(session_path.read_bytes())
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


def _log_warmup_action(
    db: Any,
    account_id: str,
    action_type: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    success: bool = True,
    error_code: str | None = None,
) -> None:
    """Insert a row into tg_warmup_actions."""
    db.execute(
        """INSERT INTO tg_warmup_actions
            (id, account_id, action_type, target_type, target_id, success, error_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            str(uuid.uuid4()),
            account_id,
            action_type,
            target_type,
            target_id,
            1 if success else 0,
            error_code,
            _now(),
        ],
    )
    db.commit()


# ---------------------------------------------------------------------------
# Individual action executors
# ---------------------------------------------------------------------------

async def _action_subscribe(
    client: Any,
    count: int,
    channels: list[str],
    account_id: str,
    db: Any,
) -> dict[str, Any]:
    """Subscribe to channels."""
    from telethon.tl.functions.channels import JoinChannelRequest  # type: ignore[import-untyped]

    done = 0
    failed = 0
    errors: list[str] = []

    targets = channels[:count] if channels else []
    if not targets:
        return {"done": 0, "failed": 0, "errors": ["No channels specified for subscribe"]}

    for ch in targets:
        try:
            await client(JoinChannelRequest(ch))
            done += 1
            _log_warmup_action(db, account_id, "SUBSCRIBE_CHANNEL",
                               target_type="channel", target_id=ch)
            log.info("warmup_script_subscribed", account_id=account_id, channel=ch)
        except Exception as exc:
            failed += 1
            err = str(exc)[:200]
            errors.append(f"{ch}: {err}")
            _log_warmup_action(db, account_id, "SUBSCRIBE_CHANNEL",
                               target_type="channel", target_id=ch,
                               success=False, error_code=err)
        await asyncio.sleep(random.uniform(5, 15))

    return {"done": done, "failed": failed, "errors": errors}


async def _action_react(
    client: Any,
    count: int,
    channels: list[str],
    emoji: str,
    account_id: str,
    db: Any,
) -> dict[str, Any]:
    """React to recent posts in channels."""
    from telethon.tl.functions.messages import SendReactionRequest  # type: ignore[import-untyped]
    from telethon.tl.types import ReactionEmoji  # type: ignore[import-untyped]

    done = 0
    failed = 0
    errors: list[str] = []

    if not channels:
        return {"done": 0, "failed": 0, "errors": ["No channels specified for react"]}

    reacted = 0
    for ch in channels:
        if reacted >= count:
            break
        try:
            entity = await client.get_entity(ch)
            messages = await client.get_messages(entity, limit=min(count - reacted, 10))
            for msg in messages:
                if reacted >= count:
                    break
                if not msg or not msg.id:
                    continue
                try:
                    await client(SendReactionRequest(
                        peer=entity,
                        msg_id=msg.id,
                        reaction=[ReactionEmoji(emoticon=emoji)],
                    ))
                    reacted += 1
                    done += 1
                    _log_warmup_action(db, account_id, "REACT_POST",
                                       target_type="channel", target_id=str(ch))
                except Exception as exc:
                    failed += 1
                    errors.append(f"react {ch}/{msg.id}: {str(exc)[:100]}")
                    _log_warmup_action(db, account_id, "REACT_POST",
                                       target_type="channel", target_id=str(ch),
                                       success=False, error_code=str(exc)[:200])
                await asyncio.sleep(random.uniform(3, 10))
        except Exception as exc:
            failed += 1
            errors.append(f"get_entity {ch}: {str(exc)[:100]}")
        await asyncio.sleep(random.uniform(5, 15))

    return {"done": done, "failed": failed, "errors": errors}


async def _action_comment(
    client: Any,
    count: int,
    channels: list[str],
    text: str | None,
    account_id: str,
    db: Any,
) -> dict[str, Any]:
    """Comment on recent posts in channels."""
    done = 0
    failed = 0
    errors: list[str] = []

    if not channels:
        return {"done": 0, "failed": 0, "errors": ["No channels specified for comment"]}

    commented = 0
    for ch in channels:
        if commented >= count:
            break
        try:
            entity = await client.get_entity(ch)
            messages = await client.get_messages(entity, limit=min(count - commented, 5))
            for msg in messages:
                if commented >= count:
                    break
                if not msg or not msg.id:
                    continue
                comment_text = text if text else random.choice(GENERIC_COMMENTS)
                try:
                    await client.send_message(entity, comment_text, reply_to=msg.id)
                    commented += 1
                    done += 1
                    _log_warmup_action(db, account_id, "SHORT_REPLY",
                                       target_type="channel", target_id=str(ch))
                except Exception as exc:
                    failed += 1
                    errors.append(f"comment {ch}/{msg.id}: {str(exc)[:100]}")
                    _log_warmup_action(db, account_id, "SHORT_REPLY",
                                       target_type="channel", target_id=str(ch),
                                       success=False, error_code=str(exc)[:200])
                await asyncio.sleep(random.uniform(5, 20))
        except Exception as exc:
            failed += 1
            errors.append(f"get_entity {ch}: {str(exc)[:100]}")
        await asyncio.sleep(random.uniform(5, 15))

    return {"done": done, "failed": failed, "errors": errors}


async def _action_read_chats(
    client: Any,
    count: int,
    account_id: str,
    db: Any,
) -> dict[str, Any]:
    """Read messages from random dialogs to simulate browsing."""
    done = 0
    failed = 0
    errors: list[str] = []

    try:
        dialogs = await client.get_dialogs(limit=max(count * 2, 20))
        if not dialogs:
            return {"done": 0, "failed": 0, "errors": ["No dialogs found"]}

        selected = random.sample(dialogs, min(count, len(dialogs)))
        for dialog in selected:
            try:
                await client.get_messages(dialog, limit=5)
                await client.send_read_acknowledge(dialog)
                done += 1
                _log_warmup_action(db, account_id, "READ_CHATS",
                                   target_type="dialog",
                                   target_id=str(getattr(dialog, "id", None)))
            except Exception as exc:
                failed += 1
                errors.append(f"read {getattr(dialog, 'id', '?')}: {str(exc)[:100]}")
                _log_warmup_action(db, account_id, "READ_CHATS",
                                   target_type="dialog",
                                   target_id=str(getattr(dialog, "id", None)),
                                   success=False, error_code=str(exc)[:200])
            await asyncio.sleep(random.uniform(2, 8))
    except Exception as exc:
        errors.append(f"get_dialogs: {str(exc)[:200]}")

    return {"done": done, "failed": failed, "errors": errors}


async def _action_view_stories(
    client: Any,
    count: int,
    channels: list[str],
    account_id: str,
    db: Any,
) -> dict[str, Any]:
    """View stories on channels."""
    from telethon.tl.functions.stories import ReadStoriesRequest  # type: ignore[import-untyped]

    done = 0
    failed = 0
    errors: list[str] = []

    if not channels:
        return {"done": 0, "failed": 0, "errors": ["No channels specified for view_stories"]}

    viewed = 0
    for ch in channels:
        if viewed >= count:
            break
        try:
            entity = await client.get_entity(ch)
            # Get peer stories
            from telethon.tl.functions.stories import GetPeerStoriesRequest  # type: ignore[import-untyped]
            result = await client(GetPeerStoriesRequest(peer=entity))
            stories = getattr(result, "stories", None)
            story_items = getattr(stories, "stories", []) if stories else []

            for story in story_items:
                if viewed >= count:
                    break
                try:
                    story_id = getattr(story, "id", None)
                    if story_id is None:
                        continue
                    await client(ReadStoriesRequest(peer=entity, max_id=story_id))
                    viewed += 1
                    done += 1
                    _log_warmup_action(db, account_id, "VIEW_STORY",
                                       target_type="story",
                                       target_id=f"{ch}/{story_id}")
                except Exception as exc:
                    failed += 1
                    errors.append(f"view_story {ch}: {str(exc)[:100]}")
                    _log_warmup_action(db, account_id, "VIEW_STORY",
                                       target_type="story", target_id=str(ch),
                                       success=False, error_code=str(exc)[:200])
                await asyncio.sleep(random.uniform(2, 6))
        except Exception as exc:
            failed += 1
            errors.append(f"stories {ch}: {str(exc)[:100]}")
        await asyncio.sleep(random.uniform(5, 15))

    return {"done": done, "failed": failed, "errors": errors}


# ---------------------------------------------------------------------------
# Core async runner
# ---------------------------------------------------------------------------

async def _run_script_async(workspace_id: str, run_id: str) -> dict[str, Any]:
    """Execute a warmup script run across all selected accounts."""
    from telethon import TelegramClient  # type: ignore[import-untyped]
    from telethon.errors import (  # type: ignore[import-untyped]
        AuthKeyUnregisteredError,
        FloodWaitError,
        UserDeactivatedBanError,
    )

    db = get_db(workspace_id)
    now = _now()

    # Load run
    run_row = db.execute(
        "SELECT * FROM tg_warmup_runs WHERE id = ?", [run_id]
    ).fetchone()
    if not run_row:
        return {"status": "FAILED", "error": "Run not found"}

    script_id = run_row["script_id"]
    account_ids = json.loads(run_row["account_ids"] or "[]")

    # Load script
    script = db.execute(
        "SELECT * FROM tg_warmup_scripts WHERE id = ?", [script_id]
    ).fetchone()
    if not script:
        db.execute(
            "UPDATE tg_warmup_runs SET status='FAILED', updated_at=? WHERE id=?",
            [now, run_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "Script not found"}

    actions = json.loads(script["actions"] or "[]")
    script_target_channels = json.loads(script["target_channels"] or "[]")

    if not actions:
        db.execute(
            "UPDATE tg_warmup_runs SET status='FAILED', updated_at=? WHERE id=?",
            [now, run_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No actions defined in script"}

    # Update status to RUNNING
    db.execute(
        "UPDATE tg_warmup_runs SET status='RUNNING', started_at=?, updated_at=? WHERE id=?",
        [now, now, run_id],
    )
    db.commit()

    log.info("warmup_script_run_started", run_id=run_id, script_id=script_id,
             accounts=len(account_ids), actions=len(actions))

    total_success = 0
    total_failed = 0
    per_account_results: list[dict[str, Any]] = []

    for acc_id in account_ids:
        acc_result: dict[str, Any] = {
            "account_id": acc_id,
            "actions_done": 0,
            "actions_failed": 0,
            "errors": [],
        }

        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            acc_result["errors"].append("Account not found or not active/warming")
            per_account_results.append(acc_result)
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, run_id=run_id)
            acc_result["errors"].append("NO_PROXY: нет активного прокси")
            per_account_results.append(acc_result)
            continue

        # Write temp session
        tmp_dir = tempfile.mkdtemp(prefix="warmup_script_")
        tmp_session = Path(tmp_dir) / "ws.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

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
                    acc_result["errors"].append("Not authorized, no 2FA password")
                    per_account_results.append(acc_result)
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    continue
        except AuthKeyUnregisteredError:
            db.execute(
                "UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                [_now(), acc_id],
            )
            db.commit()
            acc_result["errors"].append("AuthKey unregistered -- marked DEAD")
            per_account_results.append(acc_result)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            acc_result["errors"].append("Account banned")
            per_account_results.append(acc_result)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue
        except Exception as e:
            acc_result["errors"].append(f"Connect error: {str(e)[:200]}")
            per_account_results.append(acc_result)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue

        log.info("warmup_script_account_connected", account_id=acc_id,
                 phone=acc_info["phone"])

        # Execute each action in the script
        for action in actions:
            action_type = action.get("type", "")
            action_count = action.get("count", 1)
            # Use action-level channels, fall back to script-level target_channels
            action_channels = action.get("channels") or script_target_channels
            action_emoji = action.get("emoji", "\U0001f44d")
            action_text = action.get("text")

            try:
                if action_type == "subscribe":
                    result = await _action_subscribe(
                        client, action_count, action_channels, acc_id, db,
                    )
                elif action_type == "react":
                    result = await _action_react(
                        client, action_count, action_channels,
                        action_emoji, acc_id, db,
                    )
                elif action_type == "comment":
                    result = await _action_comment(
                        client, action_count, action_channels,
                        action_text, acc_id, db,
                    )
                elif action_type == "read_chats":
                    result = await _action_read_chats(
                        client, action_count, acc_id, db,
                    )
                elif action_type == "view_stories":
                    result = await _action_view_stories(
                        client, action_count, action_channels, acc_id, db,
                    )
                else:
                    result = {"done": 0, "failed": 0,
                              "errors": [f"Unknown action type: {action_type}"]}

                acc_result["actions_done"] += result.get("done", 0)
                acc_result["actions_failed"] += result.get("failed", 0)
                acc_result["errors"].extend(result.get("errors", []))

            except FloodWaitError as exc:
                wait_seconds = getattr(exc, "seconds", 0)
                log.warning("warmup_script_flood_wait", account_id=acc_id,
                            wait=wait_seconds, action=action_type)
                acc_result["errors"].append(
                    f"FloodWait {wait_seconds}s during {action_type}"
                )
                if wait_seconds > 300:
                    db.execute(
                        "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                        [_now(), acc_id],
                    )
                    db.commit()
                    break  # Stop actions for this account
                else:
                    await asyncio.sleep(wait_seconds + 5)

            except Exception as exc:
                acc_result["errors"].append(
                    f"{action_type} error: {str(exc)[:200]}"
                )
                acc_result["actions_failed"] += 1

            # Random delay between actions
            await asyncio.sleep(random.uniform(5, 30))

        # Disconnect
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        total_success += acc_result["actions_done"]
        total_failed += acc_result["actions_failed"]
        per_account_results.append(acc_result)

        log.info("warmup_script_account_done", account_id=acc_id,
                 phone=acc_info["phone"],
                 done=acc_result["actions_done"],
                 failed=acc_result["actions_failed"])

        # Delay between accounts
        if acc_id != account_ids[-1]:
            await asyncio.sleep(random.uniform(10, 30))

    # Finalize run
    final_status = "COMPLETED"
    if total_success == 0 and total_failed > 0:
        final_status = "FAILED"

    now = _now()
    db.execute(
        """UPDATE tg_warmup_runs SET
            status=?, results=?, success_count=?, failed_count=?,
            finished_at=?, updated_at=?
           WHERE id=?""",
        [
            final_status,
            json.dumps(per_account_results),
            total_success, total_failed,
            now, now, run_id,
        ],
    )
    db.commit()

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "warmup_script.complete", "INFO", "warmup_run", run_id,
            f"Warmup script run complete: {total_success} done, {total_failed} failed across {len(account_ids)} accounts",
            json.dumps({
                "success": total_success, "failed": total_failed,
                "accounts": len(account_ids), "script_id": script_id,
            }),
            now,
        ],
    )
    db.commit()

    result = {
        "status": final_status,
        "success": total_success,
        "failed": total_failed,
        "accounts_processed": len(per_account_results),
    }
    log.info("warmup_script_run_complete", run_id=run_id, **result)
    return result


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------

@celery_app.task(name="pup_tg.warmup_script", bind=True, max_retries=0)
def warmup_script_run(self, workspace_id: str, run_id: str) -> dict[str, Any]:  # type: ignore[override]
    """Execute a warmup script run.

    Synchronous Celery task that runs the async Telethon session via asyncio.run().
    """
    log.info(
        "warmup_script_task_started",
        workspace_id=workspace_id,
        run_id=run_id,
        celery_task_id=self.request.id,
    )
    try:
        return asyncio.run(_run_script_async(workspace_id, run_id))
    except Exception as exc:
        log.error(
            "warmup_script_task_crashed",
            workspace_id=workspace_id,
            run_id=run_id,
            error=str(exc),
            exc_info=True,
        )
        # Update run status to FAILED
        try:
            db = get_db(workspace_id)
            db.execute(
                "UPDATE tg_warmup_runs SET status='FAILED', updated_at=? WHERE id=?",
                [_now(), run_id],
            )
            db.commit()
        except Exception:
            pass
        return {
            "status": "FAILED",
            "error": f"Task crashed: {str(exc)[:300]}",
        }
