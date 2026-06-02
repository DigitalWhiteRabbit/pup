"""Celery task for DM (direct message) campaign execution.

Connects to Telegram via Telethon using campaign accounts, sends
messages to recipients from the audience, respects rate limits,
handles FloodWait / PeerFlood / PrivacyRestricted, logs every
send attempt to tg_dm_messages.
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
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _within_active_hours(h_start: Any, h_end: Any) -> bool:
    """True if the current UTC hour is inside [h_start, h_end). Handles windows
    that wrap past midnight. Returns True if the window is degenerate/unparseable."""
    try:
        s = int(h_start) % 24
        e = int(h_end) % 24
    except (TypeError, ValueError):
        return True
    if s == e:
        return True
    cur = datetime.now(timezone.utc).hour
    if s < e:
        return s <= cur < e
    return cur >= s or cur < e


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
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
    acc = db.execute("SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'", [account_id]).fetchone()
    if not acc:
        return None
    # Check capabilities — skip accounts that can't send DM
    caps = json.loads(acc["capabilities"] or "{}")
    if caps.get("can_send_dm") is False:
        log.warning("dm_account_no_capability", account_id=account_id, reason="can_send_dm=false")
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


@celery_app.task(name="pup_tg.dm_campaign", bind=True, max_retries=0)
def dm_campaign(self, workspace_id: str, campaign_id: str) -> dict:
    """Execute a DM campaign — send messages to audience members."""
    return asyncio.run(_dm_campaign_async(workspace_id, campaign_id))


async def _dm_campaign_async(workspace_id: str, campaign_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # Load campaign
    camp = db.execute("SELECT * FROM tg_dm_campaigns WHERE id = ?", [campaign_id]).fetchone()
    if not camp:
        return {"status": "FAILED", "error": "Campaign not found"}
    if camp["status"] != "RUNNING":
        return {"status": "SKIPPED", "error": f"Campaign status is {camp['status']}, not RUNNING"}

    config = json.loads(camp["config"] or "{}")
    audience_id = camp["audience_id"]
    template_id = camp["template_id"]
    account_ids = json.loads(camp["account_ids"] or "[]")

    # Load settings for limits
    stg = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    daily_limit = (stg["limits_dm_per_day"] if stg else 30)
    delay_min = config.get("delay_min", 30)
    delay_max = config.get("delay_max", 180)
    emergency_threshold = config.get("emergency_stop_ratio", 0.30)
    ramp_up = config.get("ramp_up", False)
    # Phantom-config fields now honored (P2-01):
    max_per_day = config.get("max_per_day")          # per-account cap override
    filter_username = config.get("filter_username", False)
    filter_ai_score_min = config.get("filter_ai_score_min") or 0
    exclude_audience_id = config.get("exclude_audience_id")
    skip_list = config.get("skip_list", False)
    ah_start = config.get("active_hours_start")
    ah_end = config.get("active_hours_end")

    # Active-hours gate: outside the window we pause the campaign instead of
    # sending (resumes on the next start / scheduler tick). Honors the UI's
    # active_hours_start/end which were previously ignored.
    if ah_start is not None and ah_end is not None and not _within_active_hours(ah_start, ah_end):
        db.execute("UPDATE tg_dm_campaigns SET status='PAUSED', updated_at=? WHERE id=?",
                   [now, campaign_id])
        db.commit()
        log.info("dm_outside_active_hours", campaign_id=campaign_id, start=ah_start, end=ah_end)
        return {"status": "PAUSED", "reason": "outside active hours"}

    log.info("dm_campaign_started", campaign_id=campaign_id, workspace_id=workspace_id,
             audience_id=audience_id, accounts=len(account_ids))

    # Load template variants
    variants = []
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
        db.execute("UPDATE tg_dm_campaigns SET status='FAILED', error_message=?, updated_at=? WHERE id=?",
                   ["No message template/variants found", now, campaign_id])
        db.commit()
        return {"status": "FAILED", "error": "No message variants"}

    # Load recipients from audience (not yet messaged in this campaign)
    already_sent = set()
    sent_rows = db.execute(
        "SELECT recipient_user_id FROM tg_dm_messages WHERE campaign_id = ? AND status != 'PENDING'",
        [campaign_id]
    ).fetchall()
    for r in sent_rows:
        already_sent.add(r["recipient_user_id"])

    recipients = db.execute(
        "SELECT * FROM tg_audience_members WHERE audience_id = ? ORDER BY ai_score DESC NULLS LAST",
        [audience_id]
    ).fetchall()
    # Accept recipients with tg_user_id OR username
    recipients = [r for r in recipients
                  if (r["tg_user_id"] or r["username"])
                  and (r["tg_user_id"] or 0) not in already_sent]

    # ── Recipient filters (P2-01: previously-ignored UI config) ──────────────
    if filter_username:
        recipients = [r for r in recipients if r["username"]]
    if filter_ai_score_min:
        recipients = [r for r in recipients if (r["ai_score"] or 0) >= filter_ai_score_min]
    if exclude_audience_id:
        excl_rows = db.execute(
            "SELECT tg_user_id FROM tg_audience_members WHERE audience_id = ?",
            [exclude_audience_id],
        ).fetchall()
        excl_ids = {r["tg_user_id"] for r in excl_rows if r["tg_user_id"]}
        recipients = [r for r in recipients if (r["tg_user_id"] or 0) not in excl_ids]
    if skip_list:
        # Skip anyone already messaged in ANY prior campaign (not just this one).
        prior_rows = db.execute(
            "SELECT DISTINCT recipient_user_id FROM tg_dm_messages WHERE status != 'PENDING'"
        ).fetchall()
        prior_ids = {r["recipient_user_id"] for r in prior_rows if r["recipient_user_id"]}
        recipients = [r for r in recipients if (r["tg_user_id"] or 0) not in prior_ids]

    if not recipients:
        db.execute("UPDATE tg_dm_campaigns SET status='COMPLETED', finished_at=?, updated_at=? WHERE id=?",
                   [now, now, campaign_id])
        db.commit()
        return {"status": "COMPLETED", "error": "No recipients left"}

    # Update total_recipients
    db.execute("UPDATE tg_dm_campaigns SET total_recipients=?, updated_at=? WHERE id=?",
               [len(recipients), now, campaign_id])
    db.commit()

    # Pick accounts
    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]
    if not account_ids:
        db.execute("UPDATE tg_dm_campaigns SET status='FAILED', error_message=?, updated_at=? WHERE id=?",
                   ["No ACTIVE accounts available", now, campaign_id])
        db.commit()
        return {"status": "FAILED", "error": "No active accounts"}

    # Account distribution (P2-02). Each account is independently capped at
    # effective_limit/run, so no single account is overloaded regardless of mode;
    # distribution controls *which* accounts get used when recipients < capacity.
    #   RANDOM       → shuffle order so the same account isn't always first.
    #   ROUND_ROBIN  → declared order (sequential rotation as each hits its cap).
    #   GEO_MATCHED  → needs per-proxy geo (not yet populated, see P6-08) → treated
    #                  as ROUND_ROBIN for now.
    distribution = (camp["distribution"] or "ROUND_ROBIN").upper()
    if distribution == "RANDOM":
        random.shuffle(account_ids)
    log.info("dm_distribution", mode=distribution, accounts=len(account_ids))

    # Per-account base limit: the smaller of the global setting and the
    # campaign's max_per_day override (P2-01). Ramp-up scales this base.
    base_limit = daily_limit
    if max_per_day:
        try:
            base_limit = min(daily_limit, int(max_per_day))
        except (TypeError, ValueError):
            pass
    daily_limit = base_limit

    # Ramp-up: calculate today's limit per account
    effective_limit = daily_limit
    if ramp_up:
        camp_started = camp["started_at"] or now
        try:
            start_dt = datetime.fromisoformat(camp_started.replace("Z", "+00:00"))
            days_running = max(1, (datetime.now(timezone.utc) - start_dt).days + 1)
        except Exception:
            days_running = 1
        if days_running <= 1:
            effective_limit = max(5, daily_limit // 6)
        elif days_running <= 3:
            effective_limit = max(10, daily_limit // 3)
        elif days_running <= 7:
            effective_limit = max(15, daily_limit * 2 // 3)
        log.info("dm_ramp_up", day=days_running, effective_limit=effective_limit, full_limit=daily_limit)

    # Execute sends
    total_sent = 0
    total_failed = 0
    total_skipped = 0
    flood_blocks = 0
    recipient_idx = 0

    for acc_id in account_ids:
        # Check campaign status (might have been stopped externally)
        camp_check = db.execute("SELECT status FROM tg_dm_campaigns WHERE id = ?", [campaign_id]).fetchone()
        if camp_check and camp_check["status"] != "RUNNING":
            log.info("dm_campaign_externally_stopped", campaign_id=campaign_id)
            break

        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            log.warning("dm_account_skip", account_id=acc_id, reason="not active or missing credentials")
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, campaign_id=campaign_id)
            total_skipped += 1
            continue

        # Connect to Telegram
        tmp_dir = tempfile.mkdtemp(prefix="dm_")
        tmp_session = Path(tmp_dir) / "dm.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            FloodWaitError,
            PeerFloodError,
            UserPrivacyRestrictedError,
            UserBannedInChannelError,
            SessionPasswordNeededError,
            AuthKeyUnregisteredError,
            UserDeactivatedBanError,
        )

        client = TelegramClient(
            str(tmp_session.with_suffix("")),
            acc_info["app_id"], acc_info["app_hash"],
            timeout=30, connection_retries=5, retry_delay=2,
            **acc_info["proxy_kwargs"],
        )

        try:
            await client.connect()
            if not await client.is_user_authorized():
                if acc_info["twofa"]:
                    await client.sign_in(password=str(acc_info["twofa"]))
                else:
                    log.warning("dm_auth_failed", account_id=acc_id)
                    continue
        except AuthKeyUnregisteredError:
            db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?", [_now(), acc_id])
            db.commit()
            log.error("dm_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute("UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                       [_now(), _now(), acc_id])
            db.commit()
            log.error("dm_account_banned", account_id=acc_id)
            flood_blocks += 1
            continue
        except Exception as e:
            log.error("dm_connect_error", account_id=acc_id, error=str(e)[:100])
            continue

        log.info("dm_account_connected", account_id=acc_id, phone=acc_info["phone"])

        # Send messages with this account
        sent_this_account = 0

        while recipient_idx < len(recipients) and sent_this_account < effective_limit:
            # Emergency stop check
            if total_sent + total_failed > 0:
                fail_ratio = total_failed / (total_sent + total_failed)
                if fail_ratio > emergency_threshold and total_failed >= 3:
                    log.error("dm_emergency_stop", ratio=fail_ratio, threshold=emergency_threshold)
                    db.execute("UPDATE tg_dm_campaigns SET status='EMERGENCY_STOPPED', updated_at=? WHERE id=?",
                               [_now(), campaign_id])
                    db.commit()
                    await client.disconnect()
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return {
                        "status": "EMERGENCY_STOPPED",
                        "sent": total_sent, "failed": total_failed,
                        "reason": f"Fail ratio {fail_ratio:.0%} exceeded threshold {emergency_threshold:.0%}"
                    }

            rcpt = recipients[recipient_idx]
            recipient_idx += 1
            user_id = rcpt["tg_user_id"]
            username = rcpt["username"]

            # Pick random variant
            variant_idx = random.randint(0, len(variants) - 1)
            text = variants[variant_idx]

            # Simple variable substitution
            text = text.replace("{first_name}", rcpt["first_name"] or "")
            text = text.replace("{last_name}", rcpt["last_name"] or "")
            text = text.replace("{username}", username or "")
            text = text.strip()

            msg_id = str(uuid.uuid4())

            try:
                # Resolve entity — prefer username (more reliable), fallback to user_id
                entity = None
                if username:
                    try:
                        entity = await client.get_entity(f"@{username}")
                    except Exception:
                        pass
                if entity is None and user_id:
                    entity = await client.get_entity(user_id)
                if entity is None:
                    raise ValueError(f"Cannot resolve recipient: user_id={user_id}, username={username}")

                # Send message
                sent_msg = await client.send_message(entity, text)

                # Log success
                db.execute("""
                    INSERT INTO tg_dm_messages (id, campaign_id, account_id, recipient_user_id, recipient_username,
                        text_sent, variant_index, status, sent_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?)
                """, [msg_id, campaign_id, acc_id, user_id, username, text, variant_idx, _now(), _now()])
                db.commit()

                total_sent += 1
                sent_this_account += 1
                log.info("dm_sent", account=acc_info["phone"], to=username or user_id,
                         variant=variant_idx, sent_this_acc=sent_this_account)

                # Update campaign counters
                db.execute("UPDATE tg_dm_campaigns SET sent_count=?, updated_at=? WHERE id=?",
                           [camp["sent_count"] + total_sent, _now(), campaign_id])
                # Update account-level sent_count
                db.execute("UPDATE tg_accounts SET sent_count = sent_count + 1, updated_at=? WHERE id=?",
                           [_now(), acc_id])
                db.commit()

            except UserPrivacyRestrictedError:
                db.execute("""
                    INSERT INTO tg_dm_messages (id, campaign_id, account_id, recipient_user_id, recipient_username,
                        text_sent, variant_index, status, error_code, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'SKIPPED', 'PRIVACY_RESTRICTED', ?)
                """, [msg_id, campaign_id, acc_id, user_id, username, text, variant_idx, _now()])
                db.commit()
                total_skipped += 1
                log.info("dm_privacy_restricted", to=username or user_id)

            except PeerFloodError:
                db.execute("""
                    INSERT INTO tg_dm_messages (id, campaign_id, account_id, recipient_user_id, recipient_username,
                        text_sent, variant_index, status, error_code, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', 'PEER_FLOOD', ?)
                """, [msg_id, campaign_id, acc_id, user_id, username, text, variant_idx, _now()])
                db.commit()
                total_failed += 1
                flood_blocks += 1
                log.error("dm_peer_flood", account=acc_info["phone"])
                # Stop this account
                db.execute("UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                           [_now(), acc_id])
                db.commit()
                break

            except FloodWaitError as e:
                wait_seconds = e.seconds
                log.warning("dm_flood_wait", account=acc_info["phone"], wait=wait_seconds)
                if wait_seconds > 300:
                    # Long wait — pause account for 24h
                    db.execute("UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                               [_now(), acc_id])
                    db.commit()
                    db.execute("""
                        INSERT INTO tg_dm_messages (id, campaign_id, account_id, recipient_user_id, recipient_username,
                            text_sent, variant_index, status, error_code, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?)
                    """, [msg_id, campaign_id, acc_id, user_id, username, text, variant_idx,
                          f"FLOOD_WAIT_{wait_seconds}s", _now()])
                    db.commit()
                    total_failed += 1
                    break
                else:
                    # Short wait — just sleep
                    log.info("dm_flood_sleeping", seconds=wait_seconds)
                    await asyncio.sleep(wait_seconds + 5)
                    # Retry will happen on next iteration (recipient not consumed)
                    recipient_idx -= 1

            except Exception as e:
                db.execute("""
                    INSERT INTO tg_dm_messages (id, campaign_id, account_id, recipient_user_id, recipient_username,
                        text_sent, variant_index, status, error_code, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, ?)
                """, [msg_id, campaign_id, acc_id, user_id, username, text, variant_idx,
                      str(e)[:200], _now()])
                db.commit()
                total_failed += 1
                log.warning("dm_send_error", to=username or user_id, error=str(e)[:100])

            # Random delay between messages
            delay = random.uniform(delay_min, delay_max)
            log.info("dm_sleeping", seconds=round(delay, 1))
            await asyncio.sleep(delay)

        # Disconnect this account
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        log.info("dm_account_done", account=acc_info["phone"],
                 sent=sent_this_account, total_sent=total_sent)

    # Finalize campaign
    final_status = "COMPLETED" if recipient_idx >= len(recipients) else "PAUSED"
    db.execute("""
        UPDATE tg_dm_campaigns SET
            status=?, sent_count=?, failed_count=?, finished_at=?, updated_at=?
        WHERE id=?
    """, [final_status, camp["sent_count"] + total_sent, camp["failed_count"] + total_failed,
          _now(), _now(), campaign_id])
    db.commit()

    # Audit log
    db.execute("""
        INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, [
        "dm_campaign.complete", "INFO", "dm_campaign", campaign_id,
        f"DM campaign complete: {total_sent} sent, {total_failed} failed, {total_skipped} skipped",
        json.dumps({"sent": total_sent, "failed": total_failed, "skipped": total_skipped, "flood_blocks": flood_blocks}),
        _now()
    ])
    db.commit()

    result = {
        "status": final_status,
        "sent": total_sent,
        "failed": total_failed,
        "skipped": total_skipped,
        "flood_blocks": flood_blocks,
        "recipients_processed": recipient_idx,
        "recipients_total": len(recipients),
    }
    log.info("dm_campaign_complete", campaign_id=campaign_id, **result)
    return result
