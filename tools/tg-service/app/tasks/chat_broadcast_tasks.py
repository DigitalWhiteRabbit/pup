"""Celery task for Chat Broadcast campaign execution.

Connects to Telegram via Telethon using campaign accounts, sends
messages to target channels/chats from template variants, respects
rate limits, handles SlowMode / ChatWriteForbidden / ChannelPrivate /
FloodWait / PeerFlood, logs every post attempt to tg_chat_broadcast_posts.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
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
    acc = db.execute("SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'", [account_id]).fetchone()
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


@celery_app.task(name="pup_tg.chat_broadcast", bind=True, max_retries=0)
def chat_broadcast(self, workspace_id: str, broadcast_id: str) -> dict:
    """Execute a chat broadcast -- send messages to target channels."""
    return asyncio.run(_chat_broadcast_async(workspace_id, broadcast_id))


async def _chat_broadcast_async(workspace_id: str, broadcast_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # Load broadcast
    bcast = db.execute("SELECT * FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]).fetchone()
    if not bcast:
        return {"status": "FAILED", "error": "Broadcast not found"}
    if bcast["status"] != "RUNNING":
        return {"status": "SKIPPED", "error": f"Broadcast status is {bcast['status']}, not RUNNING"}

    config = json.loads(bcast["config"] or "{}")
    template_id = bcast["template_id"]
    account_ids = json.loads(bcast["account_ids"] or "[]")
    target_channels = json.loads(bcast["target_channels"] or "[]")

    delay_min = config.get("delay_min", 60)
    delay_max = config.get("delay_max", 300)
    emergency_threshold = config.get("emergency_stop_ratio", 0.30)
    # Phantom-config fields now honored (P2-03):
    exclude_channels = config.get("exclude_channels") or []
    gap_24h = config.get("gap_24h", False)
    posts_per_day = config.get("posts_per_day")
    ban_auto_stop = config.get("ban_auto_stop", True)
    # P2-04:
    slow_mode_behavior = config.get("slow_mode_behavior", "wait")  # wait|skip|next_account
    distribution = (config.get("distribution") or "one_per_chat").lower()

    log.info("chat_broadcast_started", broadcast_id=broadcast_id, workspace_id=workspace_id,
             targets=len(target_channels), accounts=len(account_ids))

    # Load template variants
    variants: list[str] = []
    if template_id:
        var_rows = db.execute(
            "SELECT * FROM tg_template_variants WHERE template_id = ? ORDER BY position", [template_id]
        ).fetchall()
        variants = [r["text"] for r in var_rows if r["text"]]
    if not variants:
        # Fallback: single text from config
        txt = config.get("message_text", "")
        if txt:
            variants = [txt]
    if not variants:
        db.execute("UPDATE tg_chat_broadcasts SET status='FAILED', updated_at=? WHERE id=?",
                   [now, broadcast_id])
        db.commit()
        return {"status": "FAILED", "error": "No message template/variants found"}

    if not target_channels:
        db.execute("UPDATE tg_chat_broadcasts SET status='FAILED', updated_at=? WHERE id=?",
                   [now, broadcast_id])
        db.commit()
        return {"status": "FAILED", "error": "No target channels specified"}

    # Update total_targets
    db.execute("UPDATE tg_chat_broadcasts SET total_targets=?, updated_at=? WHERE id=?",
               [len(target_channels), now, broadcast_id])
    db.commit()

    # Determine which channels have already been posted to (for resume)
    already_posted = set()
    posted_rows = db.execute(
        "SELECT channel_id FROM tg_chat_broadcast_posts WHERE broadcast_id = ? AND status IN ('POSTED', 'SLOW_MODE')",
        [broadcast_id]
    ).fetchall()
    for r in posted_rows:
        already_posted.add(r["channel_id"])

    remaining_channels = [ch for ch in target_channels if ch not in already_posted]

    # ── Channel filters (P2-03: previously-ignored UI config) ────────────────
    if exclude_channels:
        excl = set(exclude_channels)
        remaining_channels = [ch for ch in remaining_channels if ch not in excl]
    if gap_24h:
        # Don't post to a channel posted to (in any broadcast) within the last 24h.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        recent_rows = db.execute(
            "SELECT DISTINCT channel_id FROM tg_chat_broadcast_posts "
            "WHERE status = 'POSTED' AND posted_at >= ?",
            [cutoff],
        ).fetchall()
        recent = {r["channel_id"] for r in recent_rows}
        if recent:
            remaining_channels = [ch for ch in remaining_channels if ch not in recent]

    log.info("chatbr_channels_filtered", total=len(target_channels),
             remaining=len(remaining_channels), excluded=len(exclude_channels), gap_24h=gap_24h)

    if not remaining_channels:
        db.execute("UPDATE tg_chat_broadcasts SET status='COMPLETED', finished_at=?, updated_at=? WHERE id=?",
                   [now, now, broadcast_id])
        db.commit()
        return {"status": "COMPLETED", "error": "All channels already posted"}

    # Pick accounts
    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]
    if not account_ids:
        db.execute("UPDATE tg_chat_broadcasts SET status='FAILED', updated_at=? WHERE id=?",
                   [now, broadcast_id])
        db.commit()
        return {"status": "FAILED", "error": "No ACTIVE accounts available"}

    # Distribution (P2-04): each channel is posted once regardless; round_robin
    # shuffles which accounts get used first so the same account isn't always the
    # one posting (one_per_chat keeps declared order).
    if distribution == "round_robin":
        random.shuffle(account_ids)
    log.info("chatbr_distribution", mode=distribution, accounts=len(account_ids))

    # Load settings for per-account daily limit; campaign posts_per_day caps it (P2-03).
    stg = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    daily_limit = (stg["limits_chat_posts_per_day"] if stg else 3)
    if posts_per_day:
        try:
            daily_limit = min(daily_limit, int(posts_per_day))
        except (TypeError, ValueError):
            pass

    # Execute posts
    total_posted = 0
    total_failed = 0
    total_banned = 0
    total_slow_mode = 0
    flood_blocks = 0
    channel_idx = 0

    for acc_id in account_ids:
        # Check broadcast status (might have been stopped externally)
        bcast_check = db.execute("SELECT status FROM tg_chat_broadcasts WHERE id = ?", [broadcast_id]).fetchone()
        if bcast_check and bcast_check["status"] != "RUNNING":
            log.info("chat_broadcast_externally_stopped", broadcast_id=broadcast_id)
            break

        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            log.warning("chatbr_account_skip", account_id=acc_id, reason="not active or missing credentials")
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, broadcast_id=broadcast_id)
            total_failed += 1
            continue

        # Connect to Telegram
        tmp_dir = tempfile.mkdtemp(prefix="chatbr_")
        tmp_session = Path(tmp_dir) / "chatbr.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            FloodWaitError,
            PeerFloodError,
            ChatWriteForbiddenError,
            ChannelPrivateError,
            SlowModeWaitError,
            AuthKeyUnregisteredError,
            UserDeactivatedBanError,
            UserBannedInChannelError,
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
                    log.warning("chatbr_auth_failed", account_id=acc_id)
                    continue
        except AuthKeyUnregisteredError:
            db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?", [_now(), acc_id])
            db.commit()
            log.error("chatbr_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute("UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                       [_now(), _now(), acc_id])
            db.commit()
            log.error("chatbr_account_banned", account_id=acc_id)
            flood_blocks += 1
            continue
        except Exception as e:
            log.error("chatbr_connect_error", account_id=acc_id, error=str(e)[:100])
            continue

        log.info("chatbr_account_connected", account_id=acc_id, phone=acc_info["phone"])

        # Post messages with this account
        posted_this_account = 0

        # P5-01: persistent daily cap across all broadcasts + worker restarts.
        from app.core.daily_usage import ACTION_CHAT_POST, get_usage, incr_usage
        if get_usage(db, acc_id, ACTION_CHAT_POST) >= daily_limit:
            log.info("chatbr_daily_cap_reached", account_id=acc_id, cap=daily_limit)
            try:
                await client.disconnect()
            except Exception:
                pass
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue

        while channel_idx < len(remaining_channels) and posted_this_account < daily_limit:
            # P5-01: stop this account once it hits its persistent daily cap.
            if get_usage(db, acc_id, ACTION_CHAT_POST) >= daily_limit:
                log.info("chatbr_daily_cap_mid_run", account_id=acc_id, cap=daily_limit)
                break
            # Emergency stop check: >30% of attempts resulted in bans.
            # ban_auto_stop (P2-03) lets the operator disable this safety net.
            total_attempts = total_posted + total_failed + total_banned + total_slow_mode
            if ban_auto_stop and total_attempts > 0:
                ban_ratio = total_banned / total_attempts
                if ban_ratio > emergency_threshold and total_banned >= 3:
                    log.error("chatbr_emergency_stop", ratio=ban_ratio, threshold=emergency_threshold)
                    db.execute(
                        "UPDATE tg_chat_broadcasts SET status='EMERGENCY_STOPPED', "
                        "posted_count=?, banned_count=?, updated_at=? WHERE id=?",
                        [total_posted, total_banned, _now(), broadcast_id],
                    )
                    db.commit()
                    await client.disconnect()
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return {
                        "status": "EMERGENCY_STOPPED",
                        "posted": total_posted, "failed": total_failed,
                        "banned": total_banned, "slow_mode": total_slow_mode,
                        "reason": f"Ban ratio {ban_ratio:.0%} exceeded threshold {emergency_threshold:.0%}",
                    }

            channel_target = remaining_channels[channel_idx]
            channel_idx += 1

            # Pick random variant
            variant_idx = random.randint(0, len(variants) - 1)
            text = variants[variant_idx]

            post_id = str(uuid.uuid4())
            channel_title = ""

            try:
                # Resolve entity
                entity = await client.get_entity(channel_target)
                channel_title = getattr(entity, "title", "") or str(channel_target)

                # Send message
                sent_msg = await client.send_message(entity, text)

                tg_message_id = sent_msg.id if sent_msg else None

                # Log success
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, tg_message_id, status, posted_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, tg_message_id, _now(), _now()])
                db.commit()

                total_posted += 1
                posted_this_account += 1
                incr_usage(db, acc_id, ACTION_CHAT_POST)  # P5-01: persistent daily counter
                log.info("chatbr_posted", account=acc_info["phone"], channel=channel_target,
                         variant=variant_idx, posted_this_acc=posted_this_account)

                # Update broadcast counters
                db.execute(
                    "UPDATE tg_chat_broadcasts SET posted_count=?, updated_at=? WHERE id=?",
                    [bcast["posted_count"] + total_posted, _now(), broadcast_id],
                )
                db.commit()

            except SlowModeWaitError as e:
                wait_seconds = e.seconds
                log.warning("chatbr_slow_mode", channel=channel_target,
                            wait=wait_seconds, behavior=slow_mode_behavior)
                # P2-04 — slow_mode_behavior:
                #   wait         → sleep out the slow-mode (if short) and retry the
                #                  SAME channel; if too long, fall through to skip.
                #   next_account → don't consume the channel; let the next account try it.
                #   skip         → log SLOW_MODE and move on (default fallback).
                if slow_mode_behavior == "wait" and wait_seconds <= 300:
                    channel_idx -= 1  # retry same channel after the wait
                    await asyncio.sleep(wait_seconds + 1)
                    continue
                if slow_mode_behavior == "next_account":
                    channel_idx -= 1  # hand this channel to the next account
                    break
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'SLOW_MODE', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_slow_mode += 1

            except ChatWriteForbiddenError:
                log.warning("chatbr_write_forbidden", channel=channel_target)
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'BANNED_IN_CHAT', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_banned += 1
                log.info("chatbr_banned_in_chat", channel=channel_target, account=acc_info["phone"])

            except UserBannedInChannelError:
                log.warning("chatbr_user_banned_in_channel", channel=channel_target, account=acc_info["phone"])
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'BANNED_IN_CHAT', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_banned += 1

            except ChannelPrivateError:
                log.warning("chatbr_channel_private", channel=channel_target)
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_failed += 1

            except PeerFloodError:
                log.error("chatbr_peer_flood", account=acc_info["phone"])
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_failed += 1
                flood_blocks += 1
                # Stop this account
                db.execute("UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                           [_now(), acc_id])
                db.commit()
                break

            except FloodWaitError as e:
                wait_seconds = e.seconds
                log.warning("chatbr_flood_wait", account=acc_info["phone"], wait=wait_seconds)
                if wait_seconds > 300:
                    # Long wait -- pause account
                    db.execute("UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                               [_now(), acc_id])
                    db.commit()
                    db.execute("""
                        INSERT INTO tg_chat_broadcast_posts
                            (id, broadcast_id, account_id, channel_id, channel_title,
                             text_posted, variant_index, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                    """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                          text, variant_idx, _now()])
                    db.commit()
                    total_failed += 1
                    break
                else:
                    # Short wait -- sleep and retry
                    log.info("chatbr_flood_sleeping", seconds=wait_seconds)
                    await asyncio.sleep(wait_seconds + 5)
                    # Retry: move index back so this channel is attempted again
                    channel_idx -= 1

            except Exception as e:
                db.execute("""
                    INSERT INTO tg_chat_broadcast_posts
                        (id, broadcast_id, account_id, channel_id, channel_title,
                         text_posted, variant_index, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                """, [post_id, broadcast_id, acc_id, channel_target, channel_title,
                      text, variant_idx, _now()])
                db.commit()
                total_failed += 1
                log.warning("chatbr_post_error", channel=channel_target, error=str(e)[:100])

            # Random delay between posts
            delay = random.uniform(delay_min, delay_max)
            log.info("chatbr_sleeping", seconds=round(delay, 1))
            await asyncio.sleep(delay)

        # Disconnect this account
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        log.info("chatbr_account_done", account=acc_info["phone"],
                 posted=posted_this_account, total_posted=total_posted)

    # Finalize broadcast
    final_status = "COMPLETED" if channel_idx >= len(remaining_channels) else "PAUSED"
    db.execute("""
        UPDATE tg_chat_broadcasts SET
            status=?, posted_count=?, banned_count=?, deleted_count=?, finished_at=?, updated_at=?
        WHERE id=?
    """, [final_status, total_posted, total_banned,
          bcast["deleted_count"] or 0, _now(), _now(), broadcast_id])
    db.commit()

    # Audit log
    db.execute("""
        INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, [
        "chat_broadcast.complete", "INFO", "chat_broadcast", broadcast_id,
        f"Chat broadcast complete: {total_posted} posted, {total_failed} failed, "
        f"{total_banned} banned, {total_slow_mode} slow_mode",
        json.dumps({
            "posted": total_posted, "failed": total_failed,
            "banned": total_banned, "slow_mode": total_slow_mode,
            "flood_blocks": flood_blocks,
        }),
        _now()
    ])
    db.commit()

    result = {
        "status": final_status,
        "posted": total_posted,
        "failed": total_failed,
        "banned": total_banned,
        "slow_mode": total_slow_mode,
        "flood_blocks": flood_blocks,
        "channels_processed": channel_idx,
        "channels_total": len(remaining_channels),
    }
    log.info("chat_broadcast_complete", broadcast_id=broadcast_id, **result)
    return result
