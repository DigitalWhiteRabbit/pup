"""Celery task for joining accounts to Telegram chats/channels.

Connects to Telegram via Telethon, joins each account to each target
chat with randomized intervals, reads chat info (title + description)
after joining, and saves/updates channel info in tg_channels.
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

from app.config import settings
from app.core.database import get_db
from app.core.notify import notify_admin_pref
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    """Build Telethon proxy kwargs from a proxy row."""
    import python_socks
    proxy_row = db.execute("SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]).fetchone()
    if not proxy_row or proxy_row["status"] != "ACTIVE":
        return {}
    scheme = (proxy_row["scheme"] or "http").lower()
    if "socks5" in scheme:
        ptype = python_socks.ProxyType.SOCKS5
    elif "socks4" in scheme:
        ptype = python_socks.ProxyType.SOCKS4
    else:
        ptype = python_socks.ProxyType.HTTP
    return {
        "proxy": {
            "proxy_type": ptype,
            "addr": proxy_row["host"],
            "port": int(proxy_row["port"]),
            "username": proxy_row["username"],
            "password": proxy_row["password"],
            "rdns": True,
        }
    }


def _connect_account(db: Any, account_id: str) -> dict[str, Any] | None:
    """Load account row, decrypt session, build connection info."""
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ? AND status IN ('ACTIVE', 'WARMING')",
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
        "username": acc["username"],
        "first_name": acc["first_name"],
        "session_bytes": session_bytes,
        "app_id": int(app_id),
        "app_hash": str(app_hash),
        "twofa": meta.get("twoFA") or meta.get("twofa_password"),
        "proxy_kwargs": proxy_kwargs,
    }


async def _is_member(client: Any, entity: Any) -> bool:
    """Return True if the current account is ACTUALLY a participant of ``entity``.

    A successful ``JoinChannelRequest`` is not proof of membership: groups with
    "approve new members" turn a join into a pending *join request*, which looks
    like a false success. We verify via ``GetParticipant('me')``. Only a
    definitive ``UserNotParticipantError`` counts as "not a member"; any other
    verification error leaves the optimistic result intact (don't punish on a
    flaky check). Basic (non-channel) groups can't be checked this way → assume
    member (the join path for those is reliable).
    """
    from telethon.errors import UserNotParticipantError
    from telethon.tl.functions.channels import GetParticipantRequest
    from telethon.tl.types import Channel

    try:
        if isinstance(entity, Channel):
            res = await client(GetParticipantRequest(entity, "me"))
            ptype = type(res.participant).__name__
            # Banned/left = present in the participant API but cannot write.
            if "Banned" in ptype or "Left" in ptype:
                return False
        return True
    except UserNotParticipantError:
        return False
    except Exception:
        return True


def _save_or_update_channel(db: Any, entity: Any, about: str | None) -> None:
    """Upsert channel info into tg_channels table."""
    from telethon.tl.types import Channel, Chat

    if not isinstance(entity, (Channel, Chat)):
        return

    tg_id = entity.id
    username = getattr(entity, "username", None)
    title = getattr(entity, "title", "") or ""
    is_public = 1 if username else 0
    members_count = getattr(entity, "participants_count", 0) or 0

    # Determine type
    if isinstance(entity, Channel):
        if entity.megagroup:
            ch_type = "SUPERGROUP"
        elif getattr(entity, "broadcast", False):
            ch_type = "CHANNEL"
        else:
            ch_type = "SUPERGROUP"
    else:
        ch_type = "BASIC_GROUP"

    now = _now()

    existing = db.execute("SELECT id FROM tg_channels WHERE tg_id = ?", [tg_id]).fetchone()
    if existing:
        db.execute(
            """UPDATE tg_channels
               SET title = ?, about = ?, username = ?, is_public = ?,
                   members_count = ?, type = ?, updated_at = ?
               WHERE tg_id = ?""",
            [title, about, username, is_public, members_count, ch_type, now, tg_id],
        )
    else:
        db.execute(
            """INSERT INTO tg_channels
                (id, tg_id, username, title, about, type, is_public,
                 members_count, role, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [str(uuid.uuid4()), tg_id, username, title, about, ch_type, is_public,
             members_count, "SOURCE", now, now],
        )
    db.commit()


@celery_app.task(name="pup_tg.join_chats", bind=True, max_retries=0)
def join_chats(self, workspace_id: str, task_id: str) -> dict:
    """Execute a join-chats task -- join accounts to target chats."""
    return asyncio.run(_join_chats_async(workspace_id, task_id))


async def _join_chats_async(workspace_id: str, task_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # Load task
    task = db.execute("SELECT * FROM tg_join_tasks WHERE id = ?", [task_id]).fetchone()
    if not task:
        return {"status": "FAILED", "error": "Task not found"}

    if task["status"] == "STOPPED":
        return {"status": "STOPPED", "error": "Task was stopped before execution"}

    target_chats = json.loads(task["target_chats"] or "[]")
    account_ids = json.loads(task["account_ids"] or "[]")
    interval_min = task["join_interval_min"] or 30
    interval_max = task["join_interval_max"] or 120

    if not target_chats or not account_ids:
        db.execute(
            "UPDATE tg_join_tasks SET status='FAILED', updated_at=? WHERE id=?",
            [now, task_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No target chats or account IDs provided"}

    # Mark as running
    db.execute(
        "UPDATE tg_join_tasks SET status='RUNNING', started_at=?, updated_at=? WHERE id=?",
        [now, now, task_id],
    )
    db.commit()

    log.info(
        "join_chats_started",
        task_id=task_id,
        workspace_id=workspace_id,
        chats=len(target_chats),
        accounts=len(account_ids),
    )

    results: list[dict[str, Any]] = []
    success_count = 0
    failed_count = 0

    for acc_id in account_ids:
        # Check if task was stopped externally
        task_check = db.execute(
            "SELECT status FROM tg_join_tasks WHERE id = ?", [task_id]
        ).fetchone()
        if task_check and task_check["status"] == "STOPPED":
            log.info("join_chats_externally_stopped", task_id=task_id)
            break

        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            log.warning("join_account_skip", account_id=acc_id, reason="not active or missing credentials")
            for chat in target_chats:
                results.append({
                    "account_id": acc_id,
                    "chat": chat,
                    "status": "FAILED",
                    "error": "Account not active or missing credentials",
                    "chat_title": None,
                    "chat_about": None,
                })
                failed_count += 1
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, task_id=task_id)
            for chat in target_chats:
                results.append({
                    "account_id": acc_id,
                    "chat": chat,
                    "status": "FAILED",
                    "error": "NO_PROXY: нет активного прокси",
                    "chat_title": None,
                    "chat_about": None,
                })
                failed_count += 1
            continue

        # Create temp session file
        tmp_dir = tempfile.mkdtemp(prefix="join_")
        tmp_session = Path(tmp_dir) / "join.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            AuthKeyUnregisteredError,
            ChannelPrivateError,
            FloodWaitError,
            InviteHashExpiredError,
            InviteHashInvalidError,
            SessionPasswordNeededError,
            UserAlreadyParticipantError,
            UserDeactivatedBanError,
        )
        from telethon.tl.functions.channels import GetFullChannelRequest, JoinChannelRequest
        from telethon.tl.functions.messages import ImportChatInviteRequest

        client = TelegramClient(
            str(tmp_session.with_suffix("")),
            acc_info["app_id"],
            acc_info["app_hash"],
            timeout=30,
            connection_retries=5,
            retry_delay=2,
            **acc_info["proxy_kwargs"],
        )

        try:
            await client.connect()
            if not await client.is_user_authorized():
                if acc_info["twofa"]:
                    await client.sign_in(password=str(acc_info["twofa"]))
                else:
                    log.warning("join_auth_failed", account_id=acc_id)
                    for chat in target_chats:
                        results.append({
                            "account_id": acc_id,
                            "chat": chat,
                            "status": "FAILED",
                            "error": "Authorization failed",
                            "chat_title": None,
                            "chat_about": None,
                        })
                        failed_count += 1
                    continue
        except AuthKeyUnregisteredError:
            db.execute(
                "UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                [_now(), acc_id],
            )
            db.commit()
            log.error("join_account_dead", account_id=acc_id)
            for chat in target_chats:
                results.append({
                    "account_id": acc_id,
                    "chat": chat,
                    "status": "FAILED",
                    "error": "Account auth key unregistered (DEAD)",
                    "chat_title": None,
                    "chat_about": None,
                })
                failed_count += 1
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            log.error("join_account_banned", account_id=acc_id)
            for chat in target_chats:
                results.append({
                    "account_id": acc_id,
                    "chat": chat,
                    "status": "FAILED",
                    "error": "Account deactivated/banned",
                    "chat_title": None,
                    "chat_about": None,
                })
                failed_count += 1
            continue
        except Exception as e:
            log.error("join_connect_error", account_id=acc_id, error=str(e)[:100])
            for chat in target_chats:
                results.append({
                    "account_id": acc_id,
                    "chat": chat,
                    "status": "FAILED",
                    "error": f"Connection error: {str(e)[:100]}",
                    "chat_title": None,
                    "chat_about": None,
                })
                failed_count += 1
            continue

        log.info("join_account_connected", account_id=acc_id, phone=acc_info["phone"])

        for chat_idx, chat in enumerate(target_chats):
            # Re-check stop status between each chat
            task_check = db.execute(
                "SELECT status FROM tg_join_tasks WHERE id = ?", [task_id]
            ).fetchone()
            if task_check and task_check["status"] == "STOPPED":
                log.info("join_chats_stopped_mid_loop", task_id=task_id)
                break

            result_entry: dict[str, Any] = {
                "account_id": acc_id,
                "account_phone": acc_info.get("phone"),
                "account_username": acc_info.get("username"),
                "account_name": acc_info.get("first_name"),
                "chat": chat,
                "status": "FAILED",
                "error": None,
                "chat_title": None,
                "chat_about": None,
            }

            try:
                # Determine if this is an invite link or a public chat
                is_invite_link = (
                    "t.me/+" in chat
                    or "t.me/joinchat/" in chat
                    or chat.startswith("+")
                )

                if is_invite_link:
                    # Extract invite hash from link
                    invite_hash = chat
                    for prefix in ("https://t.me/+", "http://t.me/+", "t.me/+",
                                   "https://t.me/joinchat/", "http://t.me/joinchat/",
                                   "t.me/joinchat/"):
                        if invite_hash.startswith(prefix):
                            invite_hash = invite_hash[len(prefix):]
                            break
                    if invite_hash.startswith("+"):
                        invite_hash = invite_hash[1:]

                    updates = await client(ImportChatInviteRequest(invite_hash))
                    # Get the chat entity from the updates
                    entity = updates.chats[0] if updates.chats else None
                else:
                    # Public chat -- normalize to username
                    chat_identifier = chat
                    for prefix in ("https://t.me/", "http://t.me/", "t.me/", "@"):
                        if chat_identifier.startswith(prefix):
                            chat_identifier = chat_identifier[len(prefix):]
                            break

                    entity = await client.get_entity(chat_identifier)

                    try:
                        await client(JoinChannelRequest(entity))
                    except UserAlreadyParticipantError:
                        result_entry["status"] = "ALREADY"

                # Read chat info after joining
                chat_title = getattr(entity, "title", None) or ""
                chat_about = None

                if entity and result_entry["status"] != "ALREADY":
                    # Verify ACTUAL membership — a "successful" join can be a
                    # pending join-request (approval-required groups). Without
                    # this check the task reports a false JOINED.
                    if await _is_member(client, entity):
                        result_entry["status"] = "JOINED"
                    else:
                        result_entry["status"] = "PENDING"
                        result_entry["error"] = (
                            "Заявка на вступление отправлена — ждёт одобрения админа "
                            "(аккаунт ещё НЕ в чате)"
                        )

                # Try to get full channel info for description
                try:
                    from telethon.tl.types import Channel
                    if isinstance(entity, Channel):
                        full = await client(GetFullChannelRequest(entity))
                        chat_about = getattr(full.full_chat, "about", None)
                    else:
                        # For basic groups, try get_entity approach
                        chat_about = getattr(entity, "about", None)
                except Exception:
                    # Non-critical: description read failed
                    pass

                result_entry["chat_title"] = chat_title
                result_entry["chat_about"] = chat_about

                # Anti-spam bots often restrict/ban a fresh account a few seconds
                # AFTER it joins. Re-verify shortly after so we report the real
                # outcome immediately instead of a false JOINED.
                if result_entry["status"] in ("JOINED", "ALREADY"):
                    try:
                        await asyncio.sleep(6)
                        if not await _is_member(client, entity):
                            result_entry["status"] = "BANNED_AFTER_JOIN"
                            result_entry["error"] = (
                                "Вступил, но через несколько секунд аккаунт "
                                "ограничили/забанили (вероятно антиспам чата)"
                            )
                            log.warning("join_banned_after_join", account=acc_info["phone"], chat=chat)
                    except Exception:
                        pass  # re-verify is best-effort

                if result_entry["status"] in ("JOINED", "ALREADY"):
                    success_count += 1
                    # Save/update channel info
                    try:
                        _save_or_update_channel(db, entity, chat_about)
                    except Exception as ch_err:
                        log.warning("join_channel_save_error", chat=chat, error=str(ch_err)[:100])
                else:
                    failed_count += 1

                log.info(
                    "join_result",
                    account=acc_info["phone"],
                    chat=chat,
                    result=result_entry["status"],
                    title=chat_title,
                )

            except UserAlreadyParticipantError:
                result_entry["status"] = "ALREADY"
                success_count += 1
                # Still try to read chat info
                try:
                    ent = await client.get_entity(chat)
                    result_entry["chat_title"] = getattr(ent, "title", None)
                    from telethon.tl.types import Channel
                    if isinstance(ent, Channel):
                        full = await client(GetFullChannelRequest(ent))
                        result_entry["chat_about"] = getattr(full.full_chat, "about", None)
                    _save_or_update_channel(db, ent, result_entry.get("chat_about"))
                except Exception:
                    pass
                log.info("join_already_participant", account=acc_info["phone"], chat=chat)

            except ChannelPrivateError:
                result_entry["status"] = "PRIVATE"
                result_entry["error"] = "Channel is private and cannot be joined"
                failed_count += 1
                log.warning("join_channel_private", account=acc_info["phone"], chat=chat)

            except InviteHashExpiredError:
                result_entry["status"] = "FAILED"
                result_entry["error"] = "Invite link has expired"
                failed_count += 1
                log.warning("join_invite_expired", chat=chat)

            except InviteHashInvalidError:
                result_entry["status"] = "FAILED"
                result_entry["error"] = "Invite link is invalid"
                failed_count += 1
                log.warning("join_invite_invalid", chat=chat)

            except FloodWaitError as e:
                wait_seconds = e.seconds
                result_entry["status"] = "FAILED"
                result_entry["error"] = f"FloodWait {wait_seconds}s"
                failed_count += 1
                log.warning(
                    "join_flood_wait",
                    account=acc_info["phone"],
                    chat=chat,
                    wait=wait_seconds,
                )
                if wait_seconds > 300:
                    db.execute(
                        "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                        [_now(), acc_id],
                    )
                    db.commit()
                    # Skip remaining chats for this account
                    results.append(result_entry)
                    # Save progress so far
                    _save_progress(db, task_id, results, success_count, failed_count)
                    break
                else:
                    # Short wait -- sleep and continue
                    await asyncio.sleep(wait_seconds + 5)

            except Exception as e:
                result_entry["status"] = "FAILED"
                result_entry["error"] = str(e)[:200]
                failed_count += 1
                log.warning("join_error", account=acc_info["phone"], chat=chat, error=str(e)[:100])

            results.append(result_entry)

            # Save progress periodically
            _save_progress(db, task_id, results, success_count, failed_count)

            # Random delay between joins (not after the last one)
            if chat_idx < len(target_chats) - 1:
                delay = random.uniform(interval_min, interval_max)
                log.info("join_sleeping", seconds=round(delay, 1))
                await asyncio.sleep(delay)

        # Disconnect this account
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        log.info("join_account_done", account=acc_info["phone"])

        # Delay between accounts too (half the interval)
        if acc_id != account_ids[-1]:
            acc_delay = random.uniform(interval_min / 2, interval_max / 2)
            log.info("join_account_delay", seconds=round(acc_delay, 1))
            await asyncio.sleep(acc_delay)

    # Finalize task
    now = _now()
    total_joins = success_count + failed_count
    final_status = "COMPLETED"

    # Check if it was stopped
    task_check = db.execute(
        "SELECT status FROM tg_join_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if task_check and task_check["status"] == "STOPPED":
        final_status = "STOPPED"

    db.execute(
        """UPDATE tg_join_tasks SET
            status=?, total_joins=?, success_count=?, failed_count=?,
            results=?, finished_at=?, updated_at=?
           WHERE id=?""",
        [
            final_status, total_joins, success_count, failed_count,
            json.dumps(results), now, now, task_id,
        ],
    )
    db.commit()

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs
            (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "join_chats.complete", "INFO", "join_task", task_id,
            f"Join chats complete: {success_count} joined, {failed_count} failed",
            json.dumps({
                "success": success_count,
                "failed": failed_count,
                "total": total_joins,
                "chats": len(target_chats),
                "accounts": len(account_ids),
            }),
            now,
        ],
    )
    db.commit()

    result = {
        "status": final_status,
        "success": success_count,
        "failed": failed_count,
        "total": total_joins,
    }
    log.info("join_chats_complete", task_id=task_id, **result)

    # Notify the admin: join finished, and flag any accounts auto-banned right
    # after joining (the anti-spam signal worth reacting to immediately).
    banned_after = sum(1 for r in results if r.get("status") == "BANNED_AFTER_JOIN")
    msg = (
        f"✅ <b>Вступление в чаты завершено</b>\n"
        f"Вступили: {success_count} · Ошибок: {failed_count}\n"
        f"Чатов: {len(target_chats)} · Аккаунтов: {len(account_ids)}"
    )
    if banned_after:
        msg += f"\n🚫 Забанены сразу после входа: {banned_after} — проверьте аккаунты/прогрев"
    if final_status == "STOPPED":
        msg += "\n⏹ Задача была остановлена вручную"
    notify_admin_pref(db, "long_task", msg)

    return result


def _save_progress(
    db: Any,
    task_id: str,
    results: list[dict],
    success_count: int,
    failed_count: int,
) -> None:
    """Persist intermediate progress to the database."""
    now = _now()
    total = success_count + failed_count
    try:
        db.execute(
            """UPDATE tg_join_tasks SET
                total_joins=?, success_count=?, failed_count=?,
                results=?, updated_at=?
               WHERE id=?""",
            [total, success_count, failed_count, json.dumps(results), now, task_id],
        )
        db.commit()
    except Exception:
        log.warning("join_save_progress_failed", task_id=task_id, exc_info=True)
