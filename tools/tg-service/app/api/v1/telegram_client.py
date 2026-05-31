"""Web Telegram Client — browse dialogs, read messages, send replies."""

from __future__ import annotations

import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.config import settings
from app.core.security import decrypt_bytes
from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/telegram", tags=["telegram-client"])

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class DialogItem(BaseModel):
    id: int
    title: str
    type: str  # "user" | "group" | "channel"
    username: str | None = None
    unread_count: int = 0
    last_message: str | None = None
    last_message_date: str | None = None
    is_pinned: bool = False
    avatar_letter: str = "?"


class MessageItem(BaseModel):
    id: int
    text: str | None = None
    date: str | None = None
    out: bool = False
    sender_name: str | None = None
    sender_id: int | None = None
    reply_to_id: int | None = None
    media_type: str | None = None


class PeerInfo(BaseModel):
    id: int
    title: str
    type: str
    username: str | None = None


class MessagesResponse(BaseModel):
    peer: PeerInfo
    messages: list[MessageItem]


class SendMessageRequest(BaseModel):
    peer_id: int | str
    text: str
    reply_to: int | None = None
    access_hash: str | None = None


class MarkReadRequest(BaseModel):
    peer_id: int | str


# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------

async def _connect_account_telethon(
    db: Any,
    account_id: str,
) -> tuple[Any, str]:
    """Connect to Telegram using stored session + proxy for a given account.

    Returns (TelegramClient, tmp_dir_path).
    The caller MUST disconnect the client and shutil.rmtree(tmp_dir) in a finally block.
    """
    from telethon import TelegramClient
    import python_socks

    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")

    # Load metadata for app_id / app_hash
    meta: dict[str, Any] = {}
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except (json.JSONDecodeError, TypeError):
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        raise HTTPException(
            status_code=400,
            detail="app_id/app_hash missing in account metadata",
        )

    # Decrypt session file
    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        raise HTTPException(
            status_code=400,
            detail="Session file not found",
        )

    try:
        session_bytes = decrypt_bytes(session_full_path.read_bytes())
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Session decryption failed: {exc}",
        )

    # Build proxy kwargs
    proxy_kwargs: dict[str, Any] = {}
    if row["proxy_id"]:
        proxy_row = db.execute(
            "SELECT * FROM tg_proxies WHERE id = ?", [row["proxy_id"]]
        ).fetchone()
        if proxy_row and proxy_row["status"] == "ACTIVE":
            scheme = (proxy_row["scheme"] or "http").lower()
            if "socks5" in scheme:
                proxy_type = python_socks.ProxyType.SOCKS5
            elif "socks4" in scheme:
                proxy_type = python_socks.ProxyType.SOCKS4
            else:
                proxy_type = python_socks.ProxyType.HTTP
            proxy_kwargs["proxy"] = {
                "proxy_type": proxy_type,
                "addr": proxy_row["host"],
                "port": int(proxy_row["port"]),
                "username": proxy_row["username"],
                "password": proxy_row["password"],
                "rdns": True,
            }
            log.info(
                "telegram_client_using_proxy",
                host=proxy_row["host"],
                port=proxy_row["port"],
                scheme=scheme,
            )

    # NO_PROXY guard: refuse BEFORE opening any connection. A proxy-less
    # account must never connect over the server's real IP (ban risk).
    if not proxy_kwargs.get("proxy"):
        log.warning("no_proxy_skip", account_id=account_id)
        raise HTTPException(
            status_code=502,
            detail="NO_PROXY: Привяжите активный прокси к аккаунту.",
        )

    # Write temp session file (Telethon needs .session file on disk)
    tmp_dir = tempfile.mkdtemp(prefix="tg_client_")
    tmp_session_path = Path(tmp_dir) / "account.session"
    tmp_session_path.write_bytes(session_bytes)

    client = TelegramClient(
        str(tmp_session_path.with_suffix("")),
        api_id=int(app_id),
        api_hash=str(app_hash),
        timeout=20,
        connection_retries=3,
        **proxy_kwargs,
    )

    try:
        await client.connect()
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(
            status_code=502,
            detail=f"PROXY_FAIL: Подключение через прокси не удалось: {exc}",
        )

    if not await client.is_user_authorized():
        # Try 2FA if password is available
        twofa = meta.get("twoFA") or meta.get("twofa_password")
        if twofa:
            try:
                from telethon.errors import SessionPasswordNeededError
                await client.sign_in(password=str(twofa))
            except Exception:
                await client.disconnect()
                shutil.rmtree(tmp_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=502,
                    detail="Session not authorized and 2FA password failed",
                )
        else:
            await client.disconnect()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(
                status_code=502,
                detail="Session not authorized (DEAD)",
            )

    return client, tmp_dir


# ---------------------------------------------------------------------------
# Helper: resolve peer entity
# ---------------------------------------------------------------------------

async def _resolve_peer(client: Any, peer_id: int | str, access_hash: int | None = None) -> Any:
    """Resolve peer_id to a Telethon entity.

    peer_id can be:
    - int: user/chat/channel ID
    - str starting with @: username
    - str that is numeric: treated as int ID
    If access_hash is provided, use InputPeerUser directly (no network call).
    """
    try:
        if isinstance(peer_id, str) and peer_id.startswith("@"):
            return await client.get_entity(peer_id)

        # Try numeric ID with access_hash (InputPeerUser)
        numeric_id = peer_id if isinstance(peer_id, int) else None
        if numeric_id is None:
            try:
                numeric_id = int(peer_id)
            except (ValueError, TypeError):
                pass

        if numeric_id and access_hash:
            from telethon.tl.types import InputPeerUser
            return InputPeerUser(user_id=numeric_id, access_hash=access_hash)

        if numeric_id:
            return await client.get_entity(numeric_id)

        return await client.get_entity(peer_id)
    except Exception as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Peer not found: {exc}",
        )


# ---------------------------------------------------------------------------
# Helper: classify entity type
# ---------------------------------------------------------------------------

def _entity_type(entity: Any) -> str:
    """Return 'user', 'group', or 'channel' from a Telethon entity."""
    from telethon.tl.types import User, Chat, Channel

    if isinstance(entity, User):
        return "user"
    if isinstance(entity, Chat):
        return "group"
    if isinstance(entity, Channel):
        return "channel" if entity.broadcast else "group"
    return "unknown"


def _entity_title(entity: Any) -> str:
    """Extract a display title from a Telethon entity."""
    from telethon.tl.types import User

    if isinstance(entity, User):
        parts = [entity.first_name or "", entity.last_name or ""]
        return " ".join(p for p in parts if p).strip() or "Unknown"
    return getattr(entity, "title", None) or "Unknown"


def _entity_username(entity: Any) -> str | None:
    """Extract username from entity, if any."""
    return getattr(entity, "username", None)


def _format_dt(dt: datetime | None) -> str | None:
    """Format datetime to ISO string."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _detect_media_type(message: Any) -> str | None:
    """Detect media type from a Telethon message."""
    from telethon.tl.types import (
        MessageMediaPhoto,
        MessageMediaDocument,
        MessageMediaWebPage,
        MessageMediaGeo,
        MessageMediaContact,
        MessageMediaPoll,
    )

    media = message.media
    if media is None:
        return None
    if isinstance(media, MessageMediaPhoto):
        return "photo"
    if isinstance(media, MessageMediaDocument):
        doc = media.document
        if doc:
            for attr in doc.attributes:
                attr_cls = type(attr).__name__
                if attr_cls == "DocumentAttributeAudio":
                    return "voice" if getattr(attr, "voice", False) else "audio"
                if attr_cls == "DocumentAttributeVideo":
                    return "video_note" if getattr(attr, "round_message", False) else "video"
                if attr_cls == "DocumentAttributeSticker":
                    return "sticker"
                if attr_cls == "DocumentAttributeAnimated":
                    return "gif"
        return "document"
    if isinstance(media, MessageMediaWebPage):
        return "webpage"
    if isinstance(media, MessageMediaGeo):
        return "location"
    if isinstance(media, MessageMediaContact):
        return "contact"
    if isinstance(media, MessageMediaPoll):
        return "poll"
    return "other"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/{account_id}/dialogs")
async def get_dialogs(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(30, ge=1, le=100),
) -> list[dict[str, Any]]:
    """Get list of dialogs (chats) for a Telegram account."""
    from telethon.errors import FloodWaitError

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _connect_account_telethon(db, account_id)

        try:
            dialogs = await client.get_dialogs(limit=limit)
        except FloodWaitError as e:
            raise HTTPException(
                status_code=429,
                detail=f"FloodWait: retry after {e.seconds} seconds",
                headers={"Retry-After": str(e.seconds)},
            )

        result: list[dict[str, Any]] = []
        for dialog in dialogs:
            entity = dialog.entity
            title = dialog.title or _entity_title(entity)
            etype = _entity_type(entity)
            username = _entity_username(entity)

            # Last message text
            last_msg_text: str | None = None
            last_msg_date: str | None = None
            if dialog.message:
                last_msg_text = dialog.message.text or ""
                if not last_msg_text and dialog.message.media:
                    last_msg_text = f"[{_detect_media_type(dialog.message) or 'media'}]"
                last_msg_date = _format_dt(dialog.message.date)

            # Avatar letter: first letter of title
            avatar_letter = "?"
            if title:
                avatar_letter = title[0].upper()

            # access_hash needed for peers without username
            ahash = getattr(entity, "access_hash", None)

            result.append({
                "id": entity.id,
                "title": title,
                "type": etype,
                "username": username,
                "access_hash": str(ahash) if ahash else None,
                "unread_count": dialog.unread_count or 0,
                "last_message": last_msg_text,
                "last_message_date": last_msg_date,
                "is_pinned": bool(dialog.pinned),
                "avatar_letter": avatar_letter,
            })

        log.info(
            "dialogs_fetched",
            account_id=account_id,
            count=len(result),
        )
        return result

    except HTTPException:
        raise
    except Exception as exc:
        log.error("dialogs_fetch_failed", account_id=account_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to fetch dialogs: {exc}")
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@router.get("/{account_id}/messages/{peer_id}")
async def get_messages(
    account_id: str,
    peer_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(50, ge=1, le=200),
    offset_id: int = Query(0, ge=0),
    ah: str | None = Query(None, description="access_hash for peers without username"),
) -> dict[str, Any]:
    """Get messages from a specific dialog."""
    from telethon.errors import FloodWaitError
    from telethon.tl.types import User

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _connect_account_telethon(db, account_id)

        # Load dialogs — this fills entity cache AND gives us direct entity references
        dialogs = await client.get_dialogs(limit=100)

        # Find entity from loaded dialogs first (most reliable)
        entity = None
        numeric_peer = None
        if not peer_id.startswith("@"):
            try:
                numeric_peer = int(peer_id)
            except ValueError:
                pass

        for dlg in dialogs:
            if numeric_peer and (dlg.entity.id == numeric_peer or dlg.id == numeric_peer):
                entity = dlg.entity
                break
            if peer_id.startswith("@") and getattr(dlg.entity, "username", None) == peer_id[1:]:
                entity = dlg.entity
                break

        # Fallback: try resolve (works for @username peers)
        if entity is None:
            try:
                ahash = int(ah) if ah else None
                entity = await _resolve_peer(client, peer_id if peer_id.startswith("@") else (numeric_peer or peer_id), access_hash=ahash)
            except Exception:
                raise HTTPException(status_code=404, detail=f"Peer not found: {peer_id}")

        title = _entity_title(entity)
        etype = _entity_type(entity)
        username = _entity_username(entity)

        # Fetch messages
        try:
            kwargs: dict[str, Any] = {"limit": limit}
            if offset_id > 0:
                kwargs["offset_id"] = offset_id
            messages = await client.get_messages(entity, **kwargs)
        except FloodWaitError as e:
            raise HTTPException(
                status_code=429,
                detail=f"FloodWait: retry after {e.seconds} seconds",
                headers={"Retry-After": str(e.seconds)},
            )

        # Build message list
        msg_list: list[dict[str, Any]] = []
        for msg in messages:
            sender_name: str | None = None
            sender_id: int | None = None

            if msg.sender:
                sender_id = msg.sender_id
                if isinstance(msg.sender, User):
                    parts = [msg.sender.first_name or "", msg.sender.last_name or ""]
                    sender_name = " ".join(p for p in parts if p).strip() or None
                else:
                    sender_name = getattr(msg.sender, "title", None)
            elif msg.sender_id:
                sender_id = msg.sender_id

            reply_to_id: int | None = None
            if msg.reply_to:
                reply_to_id = getattr(msg.reply_to, "reply_to_msg_id", None)

            msg_list.append({
                "id": msg.id,
                "text": msg.text,
                "date": _format_dt(msg.date),
                "out": bool(msg.out),
                "sender_name": sender_name,
                "sender_id": sender_id,
                "reply_to_id": reply_to_id,
                "media_type": _detect_media_type(msg) if msg.media else None,
            })

        peer_info = {
            "id": getattr(entity, "id", 0),
            "title": title,
            "type": etype,
            "username": username,
        }

        log.info(
            "messages_fetched",
            account_id=account_id,
            peer_id=peer_id,
            count=len(msg_list),
        )
        return {"peer": peer_info, "messages": msg_list}

    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "messages_fetch_failed",
            account_id=account_id,
            peer_id=peer_id,
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"Failed to fetch messages: {exc}")
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/{account_id}/send")
async def send_message(
    account_id: str,
    body: SendMessageRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Send a message to a peer."""
    from telethon.errors import FloodWaitError

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _connect_account_telethon(db, account_id)

        # Load dialogs to fill entity cache
        dialogs = await client.get_dialogs(limit=100)
        entity = None
        pid = body.peer_id
        numeric_peer = None
        if isinstance(pid, int):
            numeric_peer = pid
        elif isinstance(pid, str) and not pid.startswith("@"):
            try: numeric_peer = int(pid)
            except ValueError: pass

        for dlg in dialogs:
            if numeric_peer and (dlg.entity.id == numeric_peer or dlg.id == numeric_peer):
                entity = dlg.entity; break
            if isinstance(pid, str) and pid.startswith("@") and getattr(dlg.entity, "username", None) == pid[1:]:
                entity = dlg.entity; break

        if entity is None:
            ahash = int(body.access_hash) if body.access_hash else None
            entity = await _resolve_peer(client, body.peer_id, access_hash=ahash)

        try:
            sent = await client.send_message(
                entity,
                body.text,
                reply_to=body.reply_to,
            )
        except FloodWaitError as e:
            raise HTTPException(
                status_code=429,
                detail=f"FloodWait: retry after {e.seconds} seconds",
                headers={"Retry-After": str(e.seconds)},
            )

        sender_name: str | None = None
        sender_id: int | None = None
        if sent.sender:
            from telethon.tl.types import User
            sender_id = sent.sender_id
            if isinstance(sent.sender, User):
                parts = [sent.sender.first_name or "", sent.sender.last_name or ""]
                sender_name = " ".join(p for p in parts if p).strip() or None
            else:
                sender_name = getattr(sent.sender, "title", None)

        result = {
            "id": sent.id,
            "text": sent.text,
            "date": _format_dt(sent.date),
            "out": True,
            "sender_name": sender_name,
            "sender_id": sender_id,
            "reply_to_id": body.reply_to,
            "media_type": None,
        }

        log.info(
            "message_sent",
            account_id=account_id,
            peer_id=str(body.peer_id),
            message_id=sent.id,
        )
        return result

    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "message_send_failed",
            account_id=account_id,
            peer_id=str(body.peer_id),
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"Failed to send message: {exc}")
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/{account_id}/mark-read")
async def mark_read(
    account_id: str,
    body: MarkReadRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, bool]:
    """Mark all messages in a dialog as read."""
    from telethon.errors import FloodWaitError

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _connect_account_telethon(db, account_id)

        entity = await _resolve_peer(client, body.peer_id)

        try:
            await client.send_read_acknowledge(entity)
        except FloodWaitError as e:
            raise HTTPException(
                status_code=429,
                detail=f"FloodWait: retry after {e.seconds} seconds",
                headers={"Retry-After": str(e.seconds)},
            )

        log.info(
            "dialog_marked_read",
            account_id=account_id,
            peer_id=str(body.peer_id),
        )
        return {"ok": True}

    except HTTPException:
        raise
    except Exception as exc:
        log.error(
            "mark_read_failed",
            account_id=account_id,
            peer_id=str(body.peer_id),
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"Failed to mark as read: {exc}")
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@router.get("/{account_id}/sessions")
async def get_sessions(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get active Telegram sessions for an account."""
    from telethon.tl.functions.account import GetAuthorizationsRequest

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _connect_account_telethon(db, account_id)
        result = await client(GetAuthorizationsRequest())
        sessions = []
        for auth in result.authorizations:
            sessions.append({
                "hash": str(auth.hash),
                "current": bool(auth.current),
                "device_model": auth.device_model,
                "platform": auth.platform,
                "system_version": auth.system_version,
                "app_name": auth.app_name,
                "app_version": auth.app_version,
                "ip": auth.ip,
                "country": auth.country,
                "region": auth.region,
                "date_created": _format_dt(auth.date_created),
                "date_active": _format_dt(auth.date_active),
            })
        log.info("sessions_fetched", account_id=account_id, count=len(sessions))
        return {"sessions": sessions}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to get sessions: {exc}")
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
