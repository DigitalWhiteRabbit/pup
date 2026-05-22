"""Celery tasks for Telegram channel/group resolution.

Resolves a channel or group link via Telethon and returns its metadata
(title, member count, type, etc.). Used by the UI to validate sources
before starting a parsing task.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _pick_account(db: Any) -> dict[str, Any] | None:
    """Pick an ACTIVE account, preferring those with a proxy assigned."""
    row = db.execute(
        """SELECT * FROM tg_accounts
           WHERE status = 'ACTIVE'
           ORDER BY
               CASE WHEN proxy_id IS NOT NULL THEN 0 ELSE 1 END,
               RANDOM()
           LIMIT 1"""
    ).fetchone()
    return dict(row) if row else None


def _classify_entity_type(entity: Any) -> str:
    """Determine the entity type string from a Telethon entity."""
    from telethon.tl.types import Channel, Chat  # type: ignore[import-untyped]

    if isinstance(entity, Channel):
        if getattr(entity, "megagroup", False):
            if getattr(entity, "forum", False):
                return "FORUM"
            return "SUPERGROUP"
        return "CHANNEL"
    if isinstance(entity, Chat):
        return "BASIC_GROUP"
    return "UNKNOWN"


# ---------------------------------------------------------------------------
# Async implementation
# ---------------------------------------------------------------------------

async def _resolve_channel_async(workspace_id: str, link: str) -> dict[str, Any]:
    """Resolve a Telegram channel/group link to its metadata (async)."""
    from telethon import TelegramClient  # type: ignore[import-untyped]
    from telethon.errors import (  # type: ignore[import-untyped]
        AuthKeyUnregisteredError,
        ChannelPrivateError,
        FloodWaitError,
        InviteHashExpiredError,
        UsernameNotOccupiedError,
    )
    from telethon.tl.functions.channels import GetFullChannelRequest  # type: ignore[import-untyped]

    db = get_db(workspace_id)

    # ── Pick an account ────────────────────────────────────────────────
    account = _pick_account(db)
    if not account:
        return {"ok": False, "error": "No ACTIVE Telegram accounts available"}

    # ── Load API credentials from metadata ─────────────────────────────
    meta: dict[str, Any] = {}
    if account.get("metadata"):
        try:
            meta = json.loads(account["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        return {"ok": False, "error": "app_id/app_hash missing in account metadata"}

    # ── Decrypt session ────────────────────────────────────────────────
    session_path = Path(account["session_path"])
    if not session_path.exists():
        return {"ok": False, "error": f"Session file not found: {session_path}"}

    try:
        session_bytes = decrypt_bytes(session_path.read_bytes())
    except Exception as exc:
        return {"ok": False, "error": f"Session decrypt failed: {exc}"}

    # ── Proxy kwargs ───────────────────────────────────────────────────
    proxy_kwargs: dict[str, Any] = {}
    if account.get("proxy_id"):
        try:
            proxy_kwargs = _build_proxy_kwargs(db, account["proxy_id"])
        except Exception as exc:
            log.warning(
                "resolve_channel_proxy_failed",
                account_id=account["id"],
                error=str(exc),
            )

    # ── Write temp session ─────────────────────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="tg_resolve_")
    tmp_session_path = Path(tmp_dir) / "resolve.session"
    tmp_session_path.write_bytes(session_bytes)

    try:
        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            api_id=int(app_id),
            api_hash=str(app_hash),
            **proxy_kwargs,
        )
        await client.connect()

        if not await client.is_user_authorized():
            db.execute(
                "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
                [_now(), account["id"]],
            )
            db.commit()
            return {"ok": False, "error": "Session not authorized -- account marked DEAD"}

        # ── Resolve entity ─────────────────────────────────────────────
        await asyncio.sleep(random.uniform(1.0, 2.0))
        entity = await client.get_entity(link)

        entity_type = _classify_entity_type(entity)

        # ── Get full channel info ──────────────────────────────────────
        about = ""
        members_count = getattr(entity, "participants_count", 0) or 0

        from telethon.tl.types import Channel  # type: ignore[import-untyped]

        if isinstance(entity, Channel):
            try:
                await asyncio.sleep(random.uniform(1.0, 2.0))
                full = await client(GetFullChannelRequest(entity))
                about = getattr(full.full_chat, "about", "") or ""
                members_count = getattr(full.full_chat, "participants_count", members_count) or members_count
            except Exception as exc:
                log.warning(
                    "resolve_channel_full_info_failed",
                    link=link,
                    error=str(exc)[:200],
                )

        await client.disconnect()

        result = {
            "ok": True,
            "tg_id": entity.id,
            "username": getattr(entity, "username", None),
            "title": getattr(entity, "title", None) or getattr(entity, "first_name", None) or "",
            "about": about,
            "type": entity_type,
            "members_count": members_count,
            "is_public": not getattr(entity, "restricted", False)
            and bool(getattr(entity, "username", None)),
        }

        log.info(
            "resolve_channel_success",
            workspace_id=workspace_id,
            link=link,
            tg_id=result["tg_id"],
            title=result["title"],
            type=result["type"],
            members_count=result["members_count"],
        )

        return result

    except UsernameNotOccupiedError:
        return {"ok": False, "error": f"Username not found: {link}"}

    except ChannelPrivateError:
        return {"ok": False, "error": f"Channel is private or inaccessible: {link}"}

    except InviteHashExpiredError:
        return {"ok": False, "error": f"Invite link has expired: {link}"}

    except FloodWaitError as exc:
        wait_seconds = getattr(exc, "seconds", 0)
        log.warning(
            "resolve_channel_flood_wait",
            link=link,
            wait_seconds=wait_seconds,
            account_id=account["id"],
        )
        if wait_seconds > 300:
            db.execute(
                "UPDATE tg_accounts SET status = 'FLOOD_WAIT', updated_at = ? WHERE id = ?",
                [_now(), account["id"]],
            )
            db.commit()
        return {"ok": False, "error": f"FloodWait {wait_seconds}s -- try again later"}

    except AuthKeyUnregisteredError:
        db.execute(
            "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
            [_now(), account["id"]],
        )
        db.commit()
        return {"ok": False, "error": "AuthKey unregistered -- account marked DEAD"}

    except Exception as exc:
        log.error(
            "resolve_channel_error",
            workspace_id=workspace_id,
            link=link,
            error=str(exc),
            exc_info=True,
        )
        return {"ok": False, "error": f"Resolve failed: {str(exc)[:300]}"}

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Celery task: resolve_channel
# ---------------------------------------------------------------------------

@celery_app.task(name="pup_tg.resolve_channel")
def resolve_channel(workspace_id: str, link: str) -> dict[str, Any]:
    """Resolve a Telegram channel/group link to its metadata.

    This is a synchronous Celery task that internally runs the
    async Telethon operation via ``asyncio.run()``.
    """
    log.info(
        "resolve_channel_task_started",
        workspace_id=workspace_id,
        link=link,
    )
    try:
        return asyncio.run(_resolve_channel_async(workspace_id, link))
    except Exception as exc:
        log.error(
            "resolve_channel_task_crashed",
            workspace_id=workspace_id,
            link=link,
            error=str(exc),
            exc_info=True,
        )
        return {"ok": False, "error": f"Task crashed: {str(exc)[:300]}"}
