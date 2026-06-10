"""Web Telegram Client — browse dialogs, read messages, send replies."""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

# Max media size we will download into memory / accept for upload (anti-OOM).
_MAX_MEDIA_BYTES = 50 * 1024 * 1024

from app.config import settings
from app.core.security import decrypt_bytes
from app.deps import AdminAuth, WorkspaceDB
from app.telegram.messenger_pool import get_messenger_client, resolve_entity

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


class EditMessageRequest(BaseModel):
    text: str
    access_hash: str | None = None


class DeleteMessagesRequest(BaseModel):
    message_ids: list[int] = Field(..., min_length=1)
    revoke: bool = True  # delete for everyone (not just locally)
    access_hash: str | None = None


class ForwardMessagesRequest(BaseModel):
    from_peer: int | str
    to_peer: int | str
    message_ids: list[int] = Field(..., min_length=1)
    from_access_hash: str | None = None
    to_access_hash: str | None = None


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

    DEPRECATED (P6-03): the messenger endpoints now use the reusing
    ``messenger_pool`` (cached client + entity cache, in-memory StringSession).
    Kept for a one-off file-session connect if ever needed; not on the hot path.
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


async def _find_peer_entity(client: Any, peer_id: int | str, access_hash: str | int | None = None) -> Any:
    """Resolve a peer to a Telethon entity: scan loaded dialogs first, then resolve.

    Mirrors the resolution used by get_messages / send_message so the media
    endpoints accept the exact same peer identifiers (numeric id or @username).
    """
    dialogs = await client.get_dialogs(limit=100)
    numeric_peer: int | None = None
    pid = peer_id
    if isinstance(pid, int):
        numeric_peer = pid
    elif isinstance(pid, str) and not pid.startswith("@"):
        try:
            numeric_peer = int(pid)
        except ValueError:
            pass
    for dlg in dialogs:
        if numeric_peer and (dlg.entity.id == numeric_peer or dlg.id == numeric_peer):
            return dlg.entity
        if isinstance(pid, str) and pid.startswith("@") and getattr(dlg.entity, "username", None) == pid[1:]:
            return dlg.entity
    ahash = int(access_hash) if access_hash else None
    target = pid if (isinstance(pid, str) and pid.startswith("@")) else (numeric_peer or pid)
    return await _resolve_peer(client, target, access_hash=ahash)


def _media_filename_mime(msg: Any) -> tuple[str, str]:
    """Best-effort (filename, mime-type) for a message's downloadable media."""
    media = msg.media
    if type(media).__name__ == "MessageMediaPhoto":
        return (f"photo_{msg.id}.jpg", "image/jpeg")
    doc = getattr(media, "document", None)
    if doc is not None:
        mime = getattr(doc, "mime_type", None) or "application/octet-stream"
        fname = None
        for attr in getattr(doc, "attributes", []) or []:
            if type(attr).__name__ == "DocumentAttributeFilename":
                fname = attr.file_name
                break
        if not fname:
            ext = mimetypes.guess_extension(mime) or ".bin"
            fname = f"file_{msg.id}{ext}"
        return (fname, mime)
    return (f"media_{msg.id}.bin", "application/octet-stream")


def _peer_to_id(peer: Any) -> int | None:
    """Extract the numeric id from a Telethon Peer (User/Chat/Channel)."""
    for attr in ("user_id", "channel_id", "chat_id"):
        v = getattr(peer, attr, None)
        if v is not None:
            return v
    return None


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
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused

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
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass


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
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused

        # P6-03: resolve via the cached resolver (dialog-scan + resolve on miss,
        # then cached per account+peer so repeat opens skip get_dialogs(100)).
        try:
            entity = await resolve_entity(db, account_id, client, peer_id, ah)
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
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass


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
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused

        # P6-03: cached resolve (dialog-scan + resolve on miss, then cached).
        entity = await resolve_entity(db, account_id, client, body.peer_id, body.access_hash)

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
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass


@router.patch("/{account_id}/messages/{peer_id}/{message_id}")
async def edit_message(
    account_id: str,
    peer_id: str,
    message_id: int,
    body: EditMessageRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Edit an own outgoing message's text (P6-04)."""
    from telethon.errors import FloodWaitError, MessageNotModifiedError

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        entity = await resolve_entity(db, account_id, client, peer_id, body.access_hash)
        try:
            edited = await client.edit_message(entity, message_id, body.text)
        except MessageNotModifiedError:
            return {"id": message_id, "text": body.text, "edited": False, "reason": "not_modified"}
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})
        log.info("message_edited", account_id=account_id, peer_id=peer_id, message_id=message_id)
        return {
            "id": getattr(edited, "id", message_id),
            "text": getattr(edited, "text", body.text),
            "date": _format_dt(getattr(edited, "edit_date", None) or getattr(edited, "date", None)),
            "out": True,
            "edited": True,
        }
    except HTTPException:
        raise
    except Exception as exc:
        log.error("message_edit_failed", account_id=account_id, peer_id=peer_id,
                  message_id=message_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to edit message: {exc}")
    finally:
        pass


@router.post("/{account_id}/messages/{peer_id}/delete")
async def delete_messages(
    account_id: str,
    peer_id: str,
    body: DeleteMessagesRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Delete messages in a dialog (P6-04). ``revoke`` = delete for everyone."""
    from telethon.errors import FloodWaitError

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        entity = await resolve_entity(db, account_id, client, peer_id, body.access_hash)
        try:
            await client.delete_messages(entity, body.message_ids, revoke=body.revoke)
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})
        log.info("messages_deleted", account_id=account_id, peer_id=peer_id,
                 count=len(body.message_ids), revoke=body.revoke)
        return {"deleted": body.message_ids, "revoke": body.revoke}
    except HTTPException:
        raise
    except Exception as exc:
        log.error("messages_delete_failed", account_id=account_id, peer_id=peer_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to delete messages: {exc}")
    finally:
        pass


@router.post("/{account_id}/messages/forward")
async def forward_messages(
    account_id: str,
    body: ForwardMessagesRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Forward messages from one peer to another (P6-04)."""
    from telethon.errors import FloodWaitError

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        from_entity = await resolve_entity(db, account_id, client, body.from_peer, body.from_access_hash)
        to_entity = await resolve_entity(db, account_id, client, body.to_peer, body.to_access_hash)
        try:
            sent = await client.forward_messages(to_entity, body.message_ids, from_entity)
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})
        new_ids = [m.id for m in sent] if isinstance(sent, list) else ([sent.id] if sent else [])
        log.info("messages_forwarded", account_id=account_id, from_peer=str(body.from_peer),
                 to_peer=str(body.to_peer), count=len(body.message_ids))
        return {"forwarded": len(new_ids), "new_message_ids": new_ids}
    except HTTPException:
        raise
    except Exception as exc:
        log.error("messages_forward_failed", account_id=account_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to forward messages: {exc}")
    finally:
        pass


@router.get("/{account_id}/messages/{peer_id}/{message_id}/media")
async def download_message_media(
    account_id: str,
    peer_id: str,
    message_id: int,
    _token: AdminAuth,
    db: WorkspaceDB,
    ah: str | None = Query(None, description="access_hash for peers without username"),
) -> Response:
    """Download a message's media attachment (P6-02).

    Streams the binary back with its real content-type + filename (inline) so
    the UI can preview images or download files. 404 for non-downloadable media
    (webpage/poll/geo/contact) or missing media; 413 if over the size cap.
    """
    from telethon.errors import FloodWaitError

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        entity = await resolve_entity(db, account_id, client, peer_id, ah)

        try:
            msgs = await client.get_messages(entity, ids=[message_id])
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})
        msg = msgs[0] if msgs else None
        if msg is None or not msg.media:
            raise HTTPException(status_code=404, detail="No media in this message")

        size = getattr(getattr(msg, "file", None), "size", None)
        if size and size > _MAX_MEDIA_BYTES:
            raise HTTPException(status_code=413, detail=f"Media too large ({size} bytes, cap {_MAX_MEDIA_BYTES})")

        data = await client.download_media(msg, file=bytes)
        if not data:
            raise HTTPException(status_code=404, detail="Media not downloadable (e.g. webpage/poll/geo)")

        filename, mime = _media_filename_mime(msg)
        log.info("media_downloaded", account_id=account_id, peer_id=peer_id,
                 message_id=message_id, bytes=len(data), mime=mime)
        return Response(
            content=data,
            media_type=mime,
            headers={"Content-Disposition": f'inline; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.error("media_download_failed", account_id=account_id, peer_id=peer_id,
                  message_id=message_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to download media: {exc}")
    finally:
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass


@router.post("/{account_id}/send-media")
async def send_media(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    file: UploadFile = File(...),
    peer_id: str = Form(...),
    caption: str = Form(""),
    reply_to: int | None = Form(None),
    access_hash: str | None = Form(None),
    force_document: bool = Form(False),
) -> dict[str, Any]:
    """Send a media file to a peer via Telethon ``send_file`` (P6-02).

    Multipart upload. ``force_document=true`` sends as a plain file (no photo /
    video compression). Rejects uploads over the size cap (413).
    """
    from telethon.errors import FloodWaitError

    # Read upload (bounded) into a temp file so Telethon can infer type by name.
    raw = await file.read()
    if len(raw) > _MAX_MEDIA_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large ({len(raw)} bytes, cap {_MAX_MEDIA_BYTES})")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")

    client = None
    upload_dir = tempfile.mkdtemp(prefix="tg_send_media_")
    safe_name = os.path.basename(file.filename or "upload.bin") or "upload.bin"
    upload_path = os.path.join(upload_dir, safe_name)
    try:
        with open(upload_path, "wb") as fh:
            fh.write(raw)

        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        entity = await resolve_entity(db, account_id, client, peer_id, access_hash)

        try:
            sent = await client.send_file(
                entity,
                upload_path,
                caption=caption or None,
                reply_to=reply_to,
                force_document=force_document,
            )
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})

        result = {
            "id": sent.id,
            "text": sent.text,
            "date": _format_dt(sent.date),
            "out": True,
            "sender_name": None,
            "sender_id": sent.sender_id,
            "reply_to_id": reply_to,
            "media_type": _detect_media_type(sent) if sent.media else None,
        }
        log.info("media_sent", account_id=account_id, peer_id=peer_id,
                 message_id=sent.id, filename=safe_name, bytes=len(raw))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        log.error("media_send_failed", account_id=account_id, peer_id=peer_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to send media: {exc}")
    finally:
        # Always clean the uploaded file; the messenger client is cached/reused
        # (P6-03) so it is NOT disconnected here.
        shutil.rmtree(upload_dir, ignore_errors=True)


@router.get("/{account_id}/resolve")
async def resolve_username(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    username: str = Query(..., min_length=1, description="@username or t.me link"),
) -> dict[str, Any]:
    """Resolve a @username / t.me link to a peer (P6-05) — open chats not in dialogs."""
    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        u = username.strip()
        if "t.me/" in u:
            u = u.rsplit("/", 1)[-1]
        u = "@" + u.lstrip("@")
        try:
            entity = await client.get_entity(u)
        except Exception:  # noqa: BLE001 — unresolvable username
            raise HTTPException(status_code=404, detail=f"Не найдено: {username}")
        ahash = getattr(entity, "access_hash", None)
        log.info("username_resolved", account_id=account_id, username=u)
        return {
            "id": getattr(entity, "id", 0),
            "title": _entity_title(entity),
            "type": _entity_type(entity),
            "username": _entity_username(entity),
            "access_hash": str(ahash) if ahash else None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        log.error("username_resolve_failed", account_id=account_id, username=username, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to resolve username: {exc}")
    finally:
        pass


@router.get("/{account_id}/search")
async def search_messages(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    q: str = Query(..., min_length=1, description="global message search query"),
    limit: int = Query(30, ge=1, le=100),
) -> dict[str, Any]:
    """Global message search across all the account's chats (P6-05)."""
    from telethon.errors import FloodWaitError
    from telethon.tl.functions.messages import SearchGlobalRequest
    from telethon.tl.types import InputMessagesFilterEmpty, InputPeerEmpty

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
        try:
            res = await client(
                SearchGlobalRequest(
                    q=q,
                    filter=InputMessagesFilterEmpty(),
                    min_date=None,
                    max_date=None,
                    offset_rate=0,
                    offset_peer=InputPeerEmpty(),
                    offset_id=0,
                    limit=limit,
                )
            )
        except FloodWaitError as e:
            raise HTTPException(status_code=429, detail=f"FloodWait: retry after {e.seconds} seconds",
                                headers={"Retry-After": str(e.seconds)})

        # Build id → display-name map from returned users + chats.
        names: dict[int, str] = {}
        for u in getattr(res, "users", []) or []:
            parts = [getattr(u, "first_name", "") or "", getattr(u, "last_name", "") or ""]
            names[u.id] = " ".join(p for p in parts if p).strip() or (getattr(u, "username", None) or str(u.id))
        for c in getattr(res, "chats", []) or []:
            names[c.id] = getattr(c, "title", None) or str(c.id)

        items: list[dict[str, Any]] = []
        for m in getattr(res, "messages", []) or []:
            pid = _peer_to_id(m.peer_id) if getattr(m, "peer_id", None) else None
            items.append({
                "message_id": getattr(m, "id", None),
                "peer_id": pid,
                "peer_title": names.get(pid) if pid else None,
                "text": (getattr(m, "message", None) or "")[:200],
                "date": _format_dt(getattr(m, "date", None)),
            })
        log.info("messages_searched", account_id=account_id, q=q, count=len(items))
        return {"items": items, "total": len(items), "query": q}
    except HTTPException:
        raise
    except Exception as exc:
        log.error("messages_search_failed", account_id=account_id, q=q, error=str(exc))
        raise HTTPException(status_code=502, detail=f"Failed to search: {exc}")
    finally:
        pass


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
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused

        entity = await resolve_entity(db, account_id, client, body.peer_id)

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
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass


@router.get("/{account_id}/sessions")
async def get_sessions(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get active Telegram sessions for an account."""
    from telethon.tl.functions.account import GetAuthorizationsRequest

    client = None
    try:
        client = await get_messenger_client(db, account_id)  # P6-03: cached/reused
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
        # P6-03: the messenger client is cached/reused (messenger_pool owns its
        # lifecycle via idle eviction) — do NOT disconnect it here.
        pass
