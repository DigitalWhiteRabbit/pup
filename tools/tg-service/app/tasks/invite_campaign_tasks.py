"""Celery task for invite campaign execution.

Connects to Telegram via Telethon using campaign accounts, invites
users from the audience to a target channel/group. Supports two modes:
  - DIRECT: uses InviteToChannelRequest to add users directly
  - INVITE_LINK: generates an invite link via ExportChatInviteRequest

Respects rate limits, handles FloodWait / PeerFlood / PrivacyRestricted,
logs every invite attempt to tg_invite_attempts.
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
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'", [account_id]
    ).fetchone()
    if not acc:
        return None
    # Check capabilities -- skip accounts that can't invite
    caps = json.loads(acc["capabilities"] or "{}")
    if caps.get("can_invite") is False:
        log.warning("invite_account_no_capability", account_id=account_id, reason="can_invite=false")
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


@celery_app.task(name="pup_tg.invite_campaign", bind=True, max_retries=0)
def invite_campaign(self, workspace_id: str, campaign_id: str) -> dict:
    """Execute an invite campaign -- invite audience members to a target channel."""
    return asyncio.run(_invite_campaign_async(workspace_id, campaign_id))


async def _invite_campaign_async(workspace_id: str, campaign_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # ── Load campaign ────────────────────────────────────────────────────
    camp = db.execute("SELECT * FROM tg_invite_campaigns WHERE id = ?", [campaign_id]).fetchone()
    if not camp:
        return {"status": "FAILED", "error": "Campaign not found"}
    if camp["status"] != "RUNNING":
        return {"status": "SKIPPED", "error": f"Campaign status is {camp['status']}, not RUNNING"}

    config = json.loads(camp["config"] or "{}")
    audience_id = camp["audience_id"]
    mode = camp["mode"]  # DIRECT or INVITE_LINK
    target_channel_id = camp["target_channel_id"]
    account_ids = json.loads(camp["account_ids"] or "[]")

    if not target_channel_id:
        db.execute(
            "UPDATE tg_invite_campaigns SET status='FAILED', updated_at=? WHERE id=?",
            [now, campaign_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No target_channel_id specified"}

    # ── Load settings for limits ─────────────────────────────────────────
    stg = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    daily_limit = stg["limits_invites_per_day"] if stg else 180
    delay_min = config.get("delay_min", 30)
    delay_max = config.get("delay_max", 120)
    emergency_threshold = config.get("emergency_stop_ratio", 0.30)
    ramp_up = config.get("ramp_up", False)
    # Phantom-config fields now honored (P2-05):
    filter_premium = config.get("filter_premium", False)
    filter_ai_score_min = config.get("filter_ai_score_min") or 0
    # privacy_threshold is a PERCENT (UI default 20): once the share of
    # privacy-restricted results exceeds it, the audience is a bad fit → stop.
    privacy_threshold = config.get("privacy_threshold")

    log.info(
        "invite_campaign_started",
        campaign_id=campaign_id,
        workspace_id=workspace_id,
        mode=mode,
        audience_id=audience_id,
        target=target_channel_id,
        accounts=len(account_ids),
    )

    # ── Load audience (skip already invited) ─────────────────────────────
    already_invited = set()
    inv_rows = db.execute(
        "SELECT invitee_user_id FROM tg_invite_attempts WHERE campaign_id = ? AND result != 'FAILED'",
        [campaign_id],
    ).fetchall()
    for r in inv_rows:
        if r["invitee_user_id"]:
            already_invited.add(r["invitee_user_id"])

    recipients = db.execute(
        "SELECT * FROM tg_audience_members WHERE audience_id = ? ORDER BY ai_score DESC NULLS LAST",
        [audience_id],
    ).fetchall()
    # Filter: must have tg_user_id or username, and not already invited
    recipients = [
        r for r in recipients
        if (r["tg_user_id"] or r["username"])
        and (r["tg_user_id"] or 0) not in already_invited
    ]
    # ── Recipient filters (P2-05: previously-ignored UI config) ──────────────
    if filter_premium:
        recipients = [r for r in recipients if r["is_premium"]]
    if filter_ai_score_min:
        recipients = [r for r in recipients if (r["ai_score"] or 0) >= filter_ai_score_min]
    log.info("invite_recipients_filtered", count=len(recipients),
             filter_premium=filter_premium, ai_score_min=filter_ai_score_min)

    if not recipients:
        db.execute(
            "UPDATE tg_invite_campaigns SET status='COMPLETED', finished_at=?, updated_at=? WHERE id=?",
            [now, now, campaign_id],
        )
        db.commit()
        return {"status": "COMPLETED", "error": "No recipients left"}

    # ── Pick accounts ────────────────────────────────────────────────────
    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]
    if not account_ids:
        db.execute(
            "UPDATE tg_invite_campaigns SET status='FAILED', updated_at=? WHERE id=?",
            [now, campaign_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No ACTIVE accounts available"}

    # ── Ramp-up: calculate today's limit per account ─────────────────────
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
            effective_limit = max(20, daily_limit * 2 // 3)
        log.info("invite_ramp_up", day=days_running, effective_limit=effective_limit, full_limit=daily_limit)

    # ── Execute invites ──────────────────────────────────────────────────
    total_success = 0
    total_privacy = 0
    total_already = 0
    total_not_found = 0
    total_failed = 0
    flood_blocks = 0
    recipient_idx = 0

    for acc_id in account_ids:
        # Check campaign status (might have been stopped externally)
        camp_check = db.execute("SELECT status FROM tg_invite_campaigns WHERE id = ?", [campaign_id]).fetchone()
        if camp_check and camp_check["status"] != "RUNNING":
            log.info("invite_campaign_externally_stopped", campaign_id=campaign_id)
            break

        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            log.warning("invite_account_skip", account_id=acc_id, reason="not active or missing credentials")
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, campaign_id=campaign_id)
            total_failed += 1
            continue

        # Connect to Telegram
        tmp_dir = tempfile.mkdtemp(prefix="invite_")
        tmp_session = Path(tmp_dir) / "invite.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            AuthKeyUnregisteredError,
            ChatAdminRequiredError,
            FloodWaitError,
            InputUserDeactivatedError,
            PeerFloodError,
            SessionPasswordNeededError,
            UserAlreadyParticipantError,
            UserBannedInChannelError,
            UserDeactivatedBanError,
            UserNotMutualContactError,
            UserPrivacyRestrictedError,
        )
        from telethon.tl.functions.channels import InviteToChannelRequest
        from telethon.tl.functions.messages import ExportChatInviteRequest

        client = TelegramClient(
            str(tmp_session.with_suffix("")),
            acc_info["app_id"],
            acc_info["app_hash"],
            timeout=30,
            connection_retries=3,
            **acc_info["proxy_kwargs"],
        )

        try:
            await client.connect()
            if not await client.is_user_authorized():
                if acc_info["twofa"]:
                    await client.sign_in(password=str(acc_info["twofa"]))
                else:
                    log.warning("invite_auth_failed", account_id=acc_id)
                    continue
        except AuthKeyUnregisteredError:
            db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?", [_now(), acc_id])
            db.commit()
            log.error("invite_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            log.error("invite_account_banned", account_id=acc_id)
            flood_blocks += 1
            continue
        except Exception as e:
            log.error("invite_connect_error", account_id=acc_id, error=str(e)[:100])
            continue

        log.info("invite_account_connected", account_id=acc_id, phone=acc_info["phone"])

        # Resolve target channel entity
        try:
            # Try numeric ID first, then username
            try:
                target_entity = await client.get_entity(int(target_channel_id))
            except (ValueError, TypeError):
                target_entity = await client.get_entity(target_channel_id)
        except Exception as e:
            log.error("invite_target_resolve_failed", target=target_channel_id, error=str(e)[:100])
            await client.disconnect()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue

        # INVITE_LINK mode: generate invite link once per account
        invite_link = None
        if mode == "INVITE_LINK":
            try:
                result = await client(ExportChatInviteRequest(
                    peer=target_entity,
                    expire_date=None,
                    usage_limit=0,  # unlimited
                    title=f"Campaign {camp['name'][:30]}",
                ))
                invite_link = result.link
                log.info("invite_link_generated", link=invite_link, account=acc_info["phone"])
            except ChatAdminRequiredError:
                log.error("invite_link_admin_required", account=acc_info["phone"], target=target_channel_id)
                await client.disconnect()
                shutil.rmtree(tmp_dir, ignore_errors=True)
                continue
            except Exception as e:
                log.error("invite_link_generate_failed", account=acc_info["phone"], error=str(e)[:100])
                await client.disconnect()
                shutil.rmtree(tmp_dir, ignore_errors=True)
                continue

        # Invite users with this account
        invited_this_account = 0

        # P5-01: persistent daily cap across all campaigns + worker restarts.
        from app.core.daily_usage import ACTION_INVITE, get_usage, incr_usage
        if get_usage(db, acc_id, ACTION_INVITE) >= daily_limit:
            log.info("invite_daily_cap_reached", account_id=acc_id, cap=daily_limit)
            try:
                await client.disconnect()
            except Exception:
                pass
            shutil.rmtree(tmp_dir, ignore_errors=True)
            continue

        while recipient_idx < len(recipients) and invited_this_account < effective_limit:
            # P5-01: stop this account once it hits its persistent daily cap.
            if get_usage(db, acc_id, ACTION_INVITE) >= daily_limit:
                log.info("invite_daily_cap_mid_run", account_id=acc_id, cap=daily_limit)
                break
            # ── Emergency stop check ─────────────────────────────────
            total_attempts = total_success + total_privacy + total_already + total_not_found + total_failed
            if total_attempts > 0 and flood_blocks > 0:
                flood_ratio = flood_blocks / total_attempts
                if flood_ratio > emergency_threshold and flood_blocks >= 3:
                    log.error(
                        "invite_emergency_stop",
                        ratio=flood_ratio,
                        threshold=emergency_threshold,
                        flood_blocks=flood_blocks,
                    )
                    db.execute(
                        "UPDATE tg_invite_campaigns SET status='EMERGENCY_STOPPED', updated_at=? WHERE id=?",
                        [_now(), campaign_id],
                    )
                    db.commit()
                    await client.disconnect()
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return {
                        "status": "EMERGENCY_STOPPED",
                        "success": total_success,
                        "failed": total_failed,
                        "flood_blocks": flood_blocks,
                        "reason": f"Flood ratio {flood_ratio:.0%} exceeded threshold {emergency_threshold:.0%}",
                    }

            # Privacy-wall auto-stop (P2-05): too many privacy-restricted results
            # means the audience can't be invited — stop instead of burning quota.
            if privacy_threshold and total_attempts >= 10:
                privacy_pct = total_privacy / total_attempts * 100
                if privacy_pct > float(privacy_threshold):
                    log.error("invite_privacy_stop", privacy_pct=round(privacy_pct, 1),
                              threshold=privacy_threshold, total_privacy=total_privacy)
                    db.execute(
                        "UPDATE tg_invite_campaigns SET status='EMERGENCY_STOPPED', updated_at=? WHERE id=?",
                        [_now(), campaign_id],
                    )
                    db.commit()
                    await client.disconnect()
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    return {
                        "status": "EMERGENCY_STOPPED",
                        "success": total_success,
                        "privacy": total_privacy,
                        "reason": f"Privacy-restricted {privacy_pct:.0f}% exceeded threshold {privacy_threshold}%",
                    }

            rcpt = recipients[recipient_idx]
            recipient_idx += 1
            user_id = rcpt["tg_user_id"]
            username = rcpt["username"]

            attempt_id = str(uuid.uuid4())

            try:
                # Resolve user entity
                user_entity = None
                if username:
                    try:
                        user_entity = await client.get_entity(f"@{username}")
                    except Exception:
                        pass
                if user_entity is None and user_id:
                    user_entity = await client.get_entity(user_id)
                if user_entity is None:
                    raise ValueError(f"Cannot resolve user: user_id={user_id}, username={username}")

                if mode == "DIRECT":
                    # Direct invite to channel — the user is actually added.
                    await client(InviteToChannelRequest(
                        channel=target_entity,
                        users=[user_entity],
                    ))
                    result_code = "SUCCESS"
                else:
                    # INVITE_LINK mode: the link was generated once above, but
                    # DELIVERING it to the user (a DM) is NOT performed here.
                    # Record the attempt honestly as LINK_READY rather than
                    # SUCCESS so reports don't show phantom invites. Actual
                    # delivery is the DM campaign's job (see P1-10 / future work).
                    result_code = "LINK_READY"

                # Log the attempt with its honest result code.
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username, result, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, result_code, _now()],
                )
                db.commit()

                # Only DIRECT invites count as real successes.
                if result_code == "SUCCESS":
                    total_success += 1
                    incr_usage(db, acc_id, ACTION_INVITE)  # P5-01: count real invites
                invited_this_account += 1
                log.info(
                    "invite_attempt_logged",
                    account=acc_info["phone"],
                    user=username or user_id,
                    mode=mode,
                    result=result_code,
                    invited_this_acc=invited_this_account,
                )

                # Update campaign counters
                db.execute(
                    """UPDATE tg_invite_campaigns
                       SET total_attempts=?, success_count=?, updated_at=?
                       WHERE id=?""",
                    [
                        camp["total_attempts"] + recipient_idx,
                        camp["success_count"] + total_success,
                        _now(),
                        campaign_id,
                    ],
                )
                db.commit()

            except UserPrivacyRestrictedError:
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'PRIVACY_RESTRICTED', 'UserPrivacyRestrictedError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_privacy += 1
                log.info("invite_privacy_restricted", user=username or user_id)

            except UserAlreadyParticipantError:
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'ALREADY_PARTICIPANT', 'UserAlreadyParticipantError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_already += 1
                log.info("invite_already_participant", user=username or user_id)

            except UserNotMutualContactError:
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'PRIVACY_RESTRICTED', 'UserNotMutualContactError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_privacy += 1
                log.info("invite_not_mutual_contact", user=username or user_id)

            except InputUserDeactivatedError:
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'USER_NOT_FOUND', 'InputUserDeactivatedError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_not_found += 1
                log.info("invite_user_deactivated", user=username or user_id)

            except ChatAdminRequiredError:
                log.error("invite_admin_required", account=acc_info["phone"], target=target_channel_id)
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'FAILED', 'ChatAdminRequiredError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_failed += 1
                # This account can't invite to this channel at all -- skip it
                break

            except PeerFloodError:
                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, 'PEER_FLOOD', 'PeerFloodError', ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username, _now()],
                )
                db.commit()
                total_failed += 1
                flood_blocks += 1
                log.error("invite_peer_flood", account=acc_info["phone"])
                # Stop this account -- it's rate-limited
                db.execute(
                    "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                    [_now(), acc_id],
                )
                db.commit()
                break

            except FloodWaitError as e:
                wait_seconds = e.seconds
                log.warning("invite_flood_wait", account=acc_info["phone"], wait=wait_seconds)
                if wait_seconds > 300:
                    # Long wait -- pause account
                    db.execute(
                        "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                        [_now(), acc_id],
                    )
                    db.commit()
                    db.execute(
                        """INSERT INTO tg_invite_attempts
                            (id, campaign_id, account_id, invitee_user_id, invitee_username,
                             result, error_code, created_at)
                           VALUES (?, ?, ?, ?, ?, 'PEER_FLOOD', ?, ?)""",
                        [attempt_id, campaign_id, acc_id, user_id, username,
                         f"FLOOD_WAIT_{wait_seconds}s", _now()],
                    )
                    db.commit()
                    total_failed += 1
                    break
                else:
                    # Short wait -- sleep it off
                    log.info("invite_flood_sleeping", seconds=wait_seconds)
                    await asyncio.sleep(wait_seconds + 5)
                    # Retry: put recipient back
                    recipient_idx -= 1

            except Exception as e:
                error_str = str(e)[:200]
                # Check if it looks like a "user not found" error
                if "user" in error_str.lower() and ("not found" in error_str.lower() or "invalid" in error_str.lower()):
                    result_code = "USER_NOT_FOUND"
                    total_not_found += 1
                else:
                    result_code = "FAILED"
                    total_failed += 1

                db.execute(
                    """INSERT INTO tg_invite_attempts
                        (id, campaign_id, account_id, invitee_user_id, invitee_username,
                         result, error_code, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    [attempt_id, campaign_id, acc_id, user_id, username,
                     result_code, error_str, _now()],
                )
                db.commit()
                log.warning("invite_error", user=username or user_id, error=error_str[:100])

            # Random delay between invites
            delay = random.uniform(delay_min, delay_max)
            log.info("invite_sleeping", seconds=round(delay, 1))
            await asyncio.sleep(delay)

        # Disconnect this account
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        log.info(
            "invite_account_done",
            account=acc_info["phone"],
            invited=invited_this_account,
            total_success=total_success,
        )

    # ── Finalize campaign ────────────────────────────────────────────────
    final_status = "COMPLETED" if recipient_idx >= len(recipients) else "PAUSED"
    total_attempts = total_success + total_privacy + total_already + total_not_found + total_failed
    db.execute(
        """UPDATE tg_invite_campaigns SET
            status=?, total_attempts=?, success_count=?,
            privacy_count=?, already_count=?, not_found_count=?,
            finished_at=?, updated_at=?
        WHERE id=?""",
        [
            final_status, total_attempts, total_success,
            total_privacy, total_already, total_not_found,
            _now(), _now(), campaign_id,
        ],
    )
    db.commit()

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs
            (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "invite_campaign.complete",
            "INFO",
            "invite_campaign",
            campaign_id,
            (
                f"Invite campaign complete: {total_success} success, "
                f"{total_privacy} privacy, {total_already} already, "
                f"{total_not_found} not found, {total_failed} failed"
            ),
            json.dumps({
                "mode": mode,
                "success": total_success,
                "privacy": total_privacy,
                "already": total_already,
                "not_found": total_not_found,
                "failed": total_failed,
                "flood_blocks": flood_blocks,
            }),
            _now(),
        ],
    )
    db.commit()

    result = {
        "status": final_status,
        "mode": mode,
        "success": total_success,
        "privacy": total_privacy,
        "already": total_already,
        "not_found": total_not_found,
        "failed": total_failed,
        "flood_blocks": flood_blocks,
        "recipients_processed": recipient_idx,
        "recipients_total": len(recipients),
    }
    log.info("invite_campaign_complete", campaign_id=campaign_id, **result)
    return result
