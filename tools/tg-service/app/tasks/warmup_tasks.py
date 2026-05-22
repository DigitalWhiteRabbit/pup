"""Celery tasks for automated Telegram account warmup.

Each warmup session connects to Telegram via Telethon, performs
a set of natural-looking actions based on the account's warmup level,
and logs every action to the tg_warmup_actions table.

Warmup levels determine behaviour profiles:
    0-30   FRESH        read chats, light reactions
    30-60  BEGINNER     + channel subscriptions
    60-90  ACTIVE       + short replies in groups
    90-100 EXPERIENCED  + occasional profile updates
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

# ---------------------------------------------------------------------------
# Safe channels for subscription actions
# ---------------------------------------------------------------------------

SAFE_CHANNELS = [
    "telegram",
    "durov",
    "tginfo",
    "TelegramTips",
    "contest",
    "BotNews",
    "TelegramRu",
]

# Short reactions that look natural
SHORT_REPLIES = [
    "\U0001f44d",   # thumbs up
    "\U0001f525",   # fire
    "\U0001f440",   # eyes
    "\U0001f4af",   # 100
    "\U0001f60a",   # smile
    "\u2764\ufe0f", # heart
    "+",
]

# Maximum total actions per single warmup session
MAX_ACTIONS_PER_SESSION = 15


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _warmup_profile(level: int) -> str:
    """Determine warmup profile label from numeric level."""
    if level < 30:
        return "FRESH"
    if level < 60:
        return "BEGINNER"
    if level < 90:
        return "ACTIVE"
    return "EXPERIENCED"


def _log_action(
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


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    """Build Telethon proxy kwargs from a stored proxy row."""
    import python_socks  # type: ignore[import-untyped]

    proxy_row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not proxy_row or proxy_row["status"] != "ACTIVE":
        return {}

    scheme = (proxy_row["scheme"] or "http").lower()
    if "socks5" in scheme:
        proxy_type = python_socks.ProxyType.SOCKS5
    elif "socks4" in scheme:
        proxy_type = python_socks.ProxyType.SOCKS4
    else:
        proxy_type = python_socks.ProxyType.HTTP

    return {
        "proxy": {
            "proxy_type": proxy_type,
            "addr": proxy_row["host"],
            "port": int(proxy_row["port"]),
            "username": proxy_row["username"],
            "password": proxy_row["password"],
            "rdns": True,
        }
    }


# ---------------------------------------------------------------------------
# Async warmup actions
# ---------------------------------------------------------------------------

async def action_read_chats(client: Any, count: int = 5) -> list[dict[str, Any]]:
    """Read recent messages from random dialogs to simulate browsing."""
    results: list[dict[str, Any]] = []
    try:
        dialogs = await client.get_dialogs(limit=20)
        if not dialogs:
            return results
        selected = random.sample(dialogs, min(count, len(dialogs)))
        for dialog in selected:
            try:
                await client.get_messages(dialog, limit=5)
                results.append({
                    "action": "READ_CHATS",
                    "target_type": "dialog",
                    "target_id": str(getattr(dialog, "id", None)),
                    "success": True,
                })
            except Exception as exc:
                results.append({
                    "action": "READ_CHATS",
                    "target_id": str(getattr(dialog, "id", None)),
                    "success": False,
                    "error": str(exc)[:200],
                })
            await asyncio.sleep(random.uniform(2, 8))
    except Exception as exc:
        log.warning("action_read_chats_failed", error=str(exc))
    return results


async def action_react_to_posts(client: Any, count: int = 3) -> list[dict[str, Any]]:
    """View/react to posts in channels the account is subscribed to."""
    results: list[dict[str, Any]] = []
    try:
        dialogs = await client.get_dialogs(limit=30)
        channels = [d for d in dialogs if d.is_channel]
        if not channels:
            return results
        selected = random.sample(channels, min(count, len(channels)))
        for ch in selected:
            try:
                msgs = await client.get_messages(ch, limit=10)
                if msgs:
                    msg = random.choice(msgs)
                    # Simply reading the message marks it as viewed
                    await client.send_read_acknowledge(ch, msg)
                    results.append({
                        "action": "REACT_POST",
                        "target_type": "channel",
                        "target_id": str(getattr(ch, "id", None)),
                        "success": True,
                    })
            except Exception as exc:
                results.append({
                    "action": "REACT_POST",
                    "target_type": "channel",
                    "target_id": str(getattr(ch, "id", None)),
                    "success": False,
                    "error": str(exc)[:200],
                })
            await asyncio.sleep(random.uniform(3, 10))
    except Exception as exc:
        log.warning("action_react_to_posts_failed", error=str(exc))
    return results


async def action_subscribe_channel(client: Any, count: int = 1) -> list[dict[str, Any]]:
    """Subscribe to one or more popular public channels."""
    from telethon.tl.functions.channels import JoinChannelRequest  # type: ignore[import-untyped]

    results: list[dict[str, Any]] = []
    candidates = random.sample(SAFE_CHANNELS, min(count, len(SAFE_CHANNELS)))
    for ch_name in candidates:
        try:
            await client(JoinChannelRequest(ch_name))
            results.append({
                "action": "SUBSCRIBE_CHANNEL",
                "target_type": "channel",
                "target_id": ch_name,
                "success": True,
            })
        except Exception as exc:
            results.append({
                "action": "SUBSCRIBE_CHANNEL",
                "target_type": "channel",
                "target_id": ch_name,
                "success": False,
                "error": str(exc)[:200],
            })
        await asyncio.sleep(random.uniform(3, 8))
    return results


async def action_short_reply(client: Any) -> list[dict[str, Any]]:
    """Send a short emoji/word reply in an active group chat."""
    results: list[dict[str, Any]] = []
    try:
        dialogs = await client.get_dialogs(limit=20)
        groups = [d for d in dialogs if d.is_group and d.unread_count and d.unread_count > 0]
        if not groups:
            # Fallback: any group
            groups = [d for d in dialogs if d.is_group]
        if not groups:
            return results
        group = random.choice(groups)
        try:
            reply_text = random.choice(SHORT_REPLIES)
            await client.send_message(group, reply_text)
            results.append({
                "action": "SHORT_REPLY",
                "target_type": "group",
                "target_id": str(getattr(group, "id", None)),
                "success": True,
            })
        except Exception as exc:
            results.append({
                "action": "SHORT_REPLY",
                "target_type": "group",
                "target_id": str(getattr(group, "id", None)),
                "success": False,
                "error": str(exc)[:200],
            })
    except Exception as exc:
        log.warning("action_short_reply_failed", error=str(exc))
    return results


async def action_update_profile(client: Any) -> list[dict[str, Any]]:
    """Occasionally update the 'about' field with something innocuous."""
    from telethon.tl.functions.account import UpdateProfileRequest  # type: ignore[import-untyped]

    results: list[dict[str, Any]] = []
    about_options = [
        "",
        "\U0001f30d",                    # globe
        "\U0001f4f1",                    # phone
        "\u2728",                        # sparkles
        "\U0001f680",                    # rocket
    ]
    try:
        about = random.choice(about_options)
        await client(UpdateProfileRequest(about=about))
        results.append({
            "action": "UPDATE_PROFILE",
            "target_type": "profile",
            "target_id": "about",
            "success": True,
        })
    except Exception as exc:
        results.append({
            "action": "UPDATE_PROFILE",
            "target_type": "profile",
            "target_id": "about",
            "success": False,
            "error": str(exc)[:200],
        })
    return results


# ---------------------------------------------------------------------------
# Core async warmup session
# ---------------------------------------------------------------------------

async def _warmup_session_async(workspace_id: str, account_id: str) -> dict[str, Any]:
    """Execute one warmup session for a single account (async)."""
    from telethon import TelegramClient  # type: ignore[import-untyped]
    from telethon.errors import (  # type: ignore[import-untyped]
        AuthKeyUnregisteredError,
        FloodWaitError,
        PhoneNumberBannedError,
        SessionPasswordNeededError,
        UserDeactivatedBanError,
    )

    db = get_db(workspace_id)
    errors: list[str] = []
    actions_performed = 0
    all_results: list[dict[str, Any]] = []

    # ── Load account ────────────────────────────────────────────────
    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not row:
        return {"actions_performed": 0, "new_level": 0, "errors": ["Account not found"]}

    if row["status"] != "WARMING":
        return {
            "actions_performed": 0,
            "new_level": row["warmup_level"],
            "errors": [f"Account status is {row['status']}, expected WARMING"],
        }

    current_level: int = row["warmup_level"] or 0

    # ── Load metadata for app_id / app_hash ─────────────────────────
    meta: dict[str, Any] = {}
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        return {
            "actions_performed": 0,
            "new_level": current_level,
            "errors": ["app_id/app_hash missing in account metadata"],
        }

    # ── Decrypt session ─────────────────────────────────────────────
    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        return {
            "actions_performed": 0,
            "new_level": current_level,
            "errors": [f"Session file not found: {session_path_str}"],
        }

    try:
        session_bytes = decrypt_bytes(session_full_path.read_bytes())
    except Exception as exc:
        return {
            "actions_performed": 0,
            "new_level": current_level,
            "errors": [f"Session decrypt failed: {exc}"],
        }

    # ── Write temp session for Telethon ─────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="tg_warmup_")
    tmp_session_path = Path(tmp_dir) / "warmup.session"
    tmp_session_path.write_bytes(session_bytes)

    try:
        # ── Build proxy kwargs ──────────────────────────────────────
        proxy_kwargs: dict[str, Any] = {}
        if row["proxy_id"]:
            try:
                proxy_kwargs = _build_proxy_kwargs(db, row["proxy_id"])
                if proxy_kwargs:
                    log.info(
                        "warmup_using_proxy",
                        account_id=account_id,
                        proxy_id=row["proxy_id"],
                    )
            except Exception as exc:
                log.warning(
                    "warmup_proxy_load_failed",
                    account_id=account_id,
                    error=str(exc),
                )

        # ── Connect to Telegram ─────────────────────────────────────
        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            api_id=int(app_id),
            api_hash=str(app_hash),
            **proxy_kwargs,
        )

        await client.connect()

        if not await client.is_user_authorized():
            await client.disconnect()
            db.execute(
                "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
                [_now(), account_id],
            )
            db.commit()
            return {
                "actions_performed": 0,
                "new_level": current_level,
                "errors": ["Session not authorized -- account marked DEAD"],
            }

        # ── Determine actions based on warmup level ─────────────────
        log.info(
            "warmup_session_starting",
            workspace_id=workspace_id,
            account_id=account_id,
            current_level=current_level,
        )

        if current_level < 30:
            # FRESH: read 3-5 chats, react to 1-2 posts
            read_count = random.randint(3, 5)
            react_count = random.randint(1, 2)
            all_results.extend(await action_read_chats(client, count=read_count))
            all_results.extend(await action_react_to_posts(client, count=react_count))

        elif current_level < 60:
            # BEGINNER: read 5-8 chats, react 3-5 posts, subscribe 1 channel
            read_count = random.randint(5, 8)
            react_count = random.randint(3, 5)
            all_results.extend(await action_read_chats(client, count=read_count))
            all_results.extend(await action_react_to_posts(client, count=react_count))
            all_results.extend(await action_subscribe_channel(client, count=1))

        elif current_level < 90:
            # ACTIVE: read 8-12 chats, react 5-8, subscribe 1-2, short reply
            read_count = random.randint(8, 12)
            react_count = random.randint(5, 8)
            sub_count = random.randint(1, 2)
            all_results.extend(await action_read_chats(client, count=read_count))
            all_results.extend(await action_react_to_posts(client, count=react_count))
            all_results.extend(await action_subscribe_channel(client, count=sub_count))
            all_results.extend(await action_short_reply(client))

        else:
            # EXPERIENCED: all of above + occasional profile update
            read_count = random.randint(8, 12)
            react_count = random.randint(5, 8)
            sub_count = random.randint(1, 2)
            all_results.extend(await action_read_chats(client, count=read_count))
            all_results.extend(await action_react_to_posts(client, count=react_count))
            all_results.extend(await action_subscribe_channel(client, count=sub_count))
            all_results.extend(await action_short_reply(client))
            if random.random() < 0.3:
                all_results.extend(await action_update_profile(client))

        # ── Disconnect ──────────────────────────────────────────────
        await client.disconnect()

    except FloodWaitError as exc:
        wait_seconds = getattr(exc, "seconds", 0)
        log.warning(
            "warmup_flood_wait",
            account_id=account_id,
            wait_seconds=wait_seconds,
        )
        if wait_seconds > 300:
            # FloodWait > 5 minutes -- pause the account
            db.execute(
                "UPDATE tg_accounts SET status = 'FLOOD_WAIT', updated_at = ? WHERE id = ?",
                [_now(), account_id],
            )
            db.commit()
            _log_action(
                db, account_id, "FLOOD_WAIT",
                success=False,
                error_code=f"FloodWait {wait_seconds}s",
            )
            return {
                "actions_performed": actions_performed,
                "new_level": current_level,
                "errors": [f"FloodWait {wait_seconds}s -- account set to FLOOD_WAIT"],
            }
        errors.append(f"FloodWait {wait_seconds}s (short, continuing next session)")

    except AuthKeyUnregisteredError:
        db.execute(
            "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
            [_now(), account_id],
        )
        db.commit()
        _log_action(db, account_id, "AUTH_FAILURE", success=False, error_code="AuthKeyUnregistered")
        return {
            "actions_performed": 0,
            "new_level": current_level,
            "errors": ["AuthKey unregistered -- account marked DEAD"],
        }

    except (UserDeactivatedBanError, PhoneNumberBannedError) as exc:
        db.execute(
            """UPDATE tg_accounts
               SET status = 'BANNED', banned_at = ?, ban_reason = ?, updated_at = ?
               WHERE id = ?""",
            [_now(), str(exc)[:200], _now(), account_id],
        )
        db.commit()
        _log_action(db, account_id, "BANNED", success=False, error_code=str(type(exc).__name__))
        return {
            "actions_performed": 0,
            "new_level": current_level,
            "errors": [f"Account banned: {exc}"],
        }

    except SessionPasswordNeededError:
        errors.append("2FA required -- cannot warmup without password handling")
        _log_action(db, account_id, "SESSION_ERROR", success=False, error_code="2FA_required")

    except Exception as exc:
        log.error(
            "warmup_session_error",
            account_id=account_id,
            error=str(exc),
            exc_info=True,
        )
        errors.append(f"Unexpected error: {str(exc)[:200]}")

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── Log each action result to DB ────────────────────────────────
    for result in all_results:
        success = result.get("success", False)
        if success:
            actions_performed += 1
        _log_action(
            db,
            account_id,
            result.get("action", "UNKNOWN"),
            target_type=result.get("target_type"),
            target_id=result.get("target_id"),
            success=success,
            error_code=result.get("error"),
        )

    # ── Update warmup level ─────────────────────────────────────────
    if actions_performed > 0:
        increment = random.randint(1, 3)
        new_level = min(current_level + increment, 100)
        new_profile = _warmup_profile(new_level)

        db.execute(
            """UPDATE tg_accounts
               SET warmup_level = ?, warmup_profile = ?,
                   last_session_at = ?, updated_at = ?
               WHERE id = ?""",
            [new_level, new_profile, _now(), _now(), account_id],
        )
        db.commit()

        log.info(
            "warmup_session_complete",
            workspace_id=workspace_id,
            account_id=account_id,
            actions_performed=actions_performed,
            old_level=current_level,
            new_level=new_level,
            new_profile=new_profile,
            errors_count=len(errors),
        )
    else:
        new_level = current_level
        db.execute(
            "UPDATE tg_accounts SET last_session_at = ?, updated_at = ? WHERE id = ?",
            [_now(), _now(), account_id],
        )
        db.commit()

    return {
        "actions_performed": actions_performed,
        "new_level": new_level,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Celery task: warmup_session
# ---------------------------------------------------------------------------

@celery_app.task(name="pup_tg.warmup_session", bind=True, max_retries=0)
def warmup_session(self, workspace_id: str, account_id: str) -> dict[str, Any]:  # type: ignore[override]
    """Run one warmup session for an account.

    This is a synchronous Celery task that internally runs the
    async Telethon session via ``asyncio.run()``.
    """
    log.info(
        "warmup_session_task_started",
        workspace_id=workspace_id,
        account_id=account_id,
        celery_task_id=self.request.id,
    )
    try:
        return asyncio.run(_warmup_session_async(workspace_id, account_id))
    except Exception as exc:
        log.error(
            "warmup_session_task_crashed",
            workspace_id=workspace_id,
            account_id=account_id,
            error=str(exc),
            exc_info=True,
        )
        return {
            "actions_performed": 0,
            "new_level": 0,
            "errors": [f"Task crashed: {str(exc)[:300]}"],
        }


# ---------------------------------------------------------------------------
# Celery task: warmup_check (dispatched by Beat every hour)
# ---------------------------------------------------------------------------

@celery_app.task(name="pup_tg.warmup_check")
def warmup_check() -> dict[str, Any]:
    """Hourly check: find all WARMING accounts across workspaces and dispatch sessions.

    Behaviour:
    - Scans data/ for workspace DB files
    - For each workspace, finds accounts with status=WARMING
    - Checks active_hours from tg_settings (default 09:00-22:00)
    - Dispatches warmup_session tasks with random stagger delays (0-300s)
    """
    data_dir = settings.data_dir
    if not data_dir.exists():
        log.info("warmup_check_no_data_dir")
        return {"dispatched": 0, "workspaces_scanned": 0}

    # Find all workspace DB files
    db_files = sorted(data_dir.glob("ws-*.db"))
    if not db_files:
        log.info("warmup_check_no_workspaces")
        return {"dispatched": 0, "workspaces_scanned": 0}

    dispatched = 0
    workspaces_scanned = 0

    for db_file in db_files:
        # Extract workspace_id from filename: ws-{id}.db
        ws_id = db_file.stem  # "ws-abc123"
        if ws_id.startswith("ws-"):
            ws_id = ws_id[3:]  # "abc123"
        else:
            continue

        workspaces_scanned += 1

        try:
            db = get_db(ws_id)

            # ── Check active hours ──────────────────────────────────
            settings_row = db.execute(
                "SELECT active_hours FROM tg_settings WHERE id = 'default'"
            ).fetchone()

            active_hours = "09:00-22:00"
            if settings_row and settings_row["active_hours"]:
                active_hours = settings_row["active_hours"]

            if not _is_within_active_hours(active_hours):
                log.debug(
                    "warmup_check_outside_hours",
                    workspace_id=ws_id,
                    active_hours=active_hours,
                )
                continue

            # ── Find WARMING accounts ───────────────────────────────
            warming_rows = db.execute(
                "SELECT id, phone FROM tg_accounts WHERE status = 'WARMING'"
            ).fetchall()

            if not warming_rows:
                continue

            for account_row in warming_rows:
                # Stagger: random delay 0-300 seconds
                delay = random.randint(0, 300)
                warmup_session.apply_async(
                    args=[ws_id, account_row["id"]],
                    countdown=delay,
                    queue="pup_tg_default",
                )
                dispatched += 1
                log.info(
                    "warmup_session_dispatched",
                    workspace_id=ws_id,
                    account_id=account_row["id"],
                    phone=account_row["phone"],
                    delay_seconds=delay,
                )

        except Exception as exc:
            log.error(
                "warmup_check_workspace_error",
                workspace_id=ws_id,
                error=str(exc),
                exc_info=True,
            )

    log.info(
        "warmup_check_complete",
        workspaces_scanned=workspaces_scanned,
        dispatched=dispatched,
    )
    return {"dispatched": dispatched, "workspaces_scanned": workspaces_scanned}


def _is_within_active_hours(active_hours: str) -> bool:
    """Check if current Moscow time is within the active hours window.

    Format: "HH:MM-HH:MM" (e.g. "09:00-22:00").
    Times are interpreted as Europe/Moscow.
    """
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

    try:
        parts = active_hours.split("-")
        if len(parts) != 2:
            return True  # malformed -- allow by default

        start_h, start_m = map(int, parts[0].strip().split(":"))
        end_h, end_m = map(int, parts[1].strip().split(":"))

        now_moscow = datetime.now(ZoneInfo("Europe/Moscow"))
        current_minutes = now_moscow.hour * 60 + now_moscow.minute
        start_minutes = start_h * 60 + start_m
        end_minutes = end_h * 60 + end_m

        if start_minutes <= end_minutes:
            return start_minutes <= current_minutes < end_minutes
        # Overnight range (e.g. "22:00-06:00")
        return current_minutes >= start_minutes or current_minutes < end_minutes

    except Exception:
        return True  # parse error -- allow by default
