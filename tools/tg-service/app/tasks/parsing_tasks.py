"""Celery tasks for Telegram audience parsing.

Connects to Telegram via Telethon, iterates over configured sources
(channels / groups), extracts users according to the chosen parsing mode,
applies filters, and persists results into tg_audience_members.

Parsing modes:
    CHAT_MEMBERS   — GetParticipants (full member list)
    COMMENTERS     — Authors of post comments
    WRITERS        — Message authors in a chat
    REACTIONS      — Users who reacted to posts (GetMessageReactionsListRequest)
    POLLS          — Poll voters (GetPollVotersRequest)
    JOINERS        — Recent join events (service messages)
    TOPICS         — Forum topic participants (GetForumTopicsRequest)
    GLOBAL_SEARCH  — Telegram global user search (SearchRequest)
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
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _user_to_dict(user: Any) -> dict[str, Any]:
    """Convert a Telethon User object to a flat dictionary."""
    return {
        "tg_user_id": user.id,
        "username": getattr(user, "username", None),
        "first_name": getattr(user, "first_name", None),
        "last_name": getattr(user, "last_name", None),
        "phone": getattr(user, "phone", None),
        "is_premium": bool(getattr(user, "premium", False)),
        "is_bot": bool(getattr(user, "bot", False)),
        "has_avatar": bool(getattr(user, "photo", None)),
        "about": None,  # requires additional GetFullUser call
    }


def _apply_filters(users: list[dict[str, Any]], filters: dict[str, Any]) -> list[dict[str, Any]]:
    """Apply user-defined filters to the parsed user list."""
    result = users
    if filters.get("has_avatar"):
        result = [u for u in result if u.get("has_avatar")]
    if filters.get("has_username"):
        result = [u for u in result if u.get("username")]
    if filters.get("no_bots"):
        result = [u for u in result if not u.get("is_bot")]
    if filters.get("premium_only"):
        result = [u for u in result if u.get("is_premium")]
    return result


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
    """Pick an ACTIVE account that has a proxy assigned.

    Accounts without a proxy_id are excluded entirely: a proxy-less account
    must never connect over the server's real IP. The proxy must also be
    ACTIVE — this is verified by the NO_PROXY guard at the connect site.
    """
    row = db.execute(
        """SELECT * FROM tg_accounts
           WHERE status = 'ACTIVE' AND proxy_id IS NOT NULL
           ORDER BY RANDOM()
           LIMIT 1"""
    ).fetchone()
    return dict(row) if row else None


def _update_task_progress(
    db: Any,
    task_id: str,
    *,
    progress: int,
    total_found: int,
    total_filtered: int,
) -> None:
    """Persist progress to the parsing task row."""
    db.execute(
        """UPDATE tg_parsing_tasks
           SET progress = ?, total_found = ?, total_filtered = ?, updated_at = ?
           WHERE id = ?""",
        [progress, total_found, total_filtered, _now(), task_id],
    )
    db.commit()


def _fail_task(db: Any, task_id: str, error_message: str) -> None:
    """Mark a parsing task as FAILED with a reason."""
    db.execute(
        """UPDATE tg_parsing_tasks
           SET status = 'FAILED', error_message = ?, finished_at = ?, updated_at = ?
           WHERE id = ?""",
        [error_message[:1000], _now(), _now(), task_id],
    )
    db.commit()


def _control_status(db: Any, task_id: str) -> str | None:
    """Re-read task status for cooperative pause/cancel mid-run.

    ``celery_app.control.revoke(terminate=True)`` cannot kill a task running in
    the threads pool (you can't terminate a thread), so the worker must poll the
    DB and stop itself. The API writes PAUSED/CANCELLED from a separate
    connection; ``commit()`` here ends any open read snapshot so the WAL read
    sees that latest commit. Returns 'PAUSED'/'CANCELLED' or None.
    """
    db.commit()
    row = db.execute(
        "SELECT status FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if row and row["status"] in ("PAUSED", "CANCELLED"):
        return row["status"]
    return None


def _complete_task(db: Any, task_id: str, total_found: int, total_filtered: int) -> None:
    """Mark a parsing task as COMPLETED."""
    db.execute(
        """UPDATE tg_parsing_tasks
           SET status = 'COMPLETED', progress = 100,
               total_found = ?, total_filtered = ?,
               finished_at = ?, updated_at = ?
           WHERE id = ?""",
        [total_found, total_filtered, _now(), _now(), task_id],
    )
    db.commit()


def _insert_members(
    db: Any,
    audience_id: str,
    users: list[dict[str, Any]],
    source_chat: str,
) -> int:
    """Insert parsed users into tg_audience_members with deduplication.

    Returns the number of newly inserted rows.
    """
    inserted = 0
    for u in users:
        tg_user_id = u.get("tg_user_id")
        if not tg_user_id:
            continue
        try:
            db.execute(
                """INSERT OR IGNORE INTO tg_audience_members
                    (id, audience_id, tg_user_id, username, first_name, last_name,
                     phone, about, is_premium, is_bot, has_avatar, source_chat, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    str(uuid.uuid4()),
                    audience_id,
                    tg_user_id,
                    u.get("username"),
                    u.get("first_name"),
                    u.get("last_name"),
                    u.get("phone"),
                    u.get("about"),
                    1 if u.get("is_premium") else 0,
                    1 if u.get("is_bot") else 0,
                    1 if u.get("has_avatar") else 0,
                    source_chat,
                    _now(),
                ],
            )
            if db.execute("SELECT changes()").fetchone()[0] > 0:
                inserted += 1
        except Exception as exc:
            log.warning(
                "insert_member_failed",
                tg_user_id=tg_user_id,
                audience_id=audience_id,
                error=str(exc)[:200],
            )
    db.commit()
    return inserted


def _update_audience_counts(db: Any, audience_id: str) -> None:
    """Recalculate and persist audience aggregate counts."""
    row = db.execute(
        """SELECT COUNT(*) AS total, COUNT(DISTINCT tg_user_id) AS uniq
           FROM tg_audience_members
           WHERE audience_id = ?""",
        [audience_id],
    ).fetchone()
    db.execute(
        """UPDATE tg_audiences
           SET total_count = ?, unique_count = ?, updated_at = ?
           WHERE id = ?""",
        [row["total"], row["uniq"], _now(), audience_id],
    )
    db.commit()


# ---------------------------------------------------------------------------
# Parsing mode implementations
# ---------------------------------------------------------------------------

async def _parse_chat_members(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: CHAT_MEMBERS -- GetParticipants (full member list)."""
    log.info("parse_mode_chat_members", entity=str(entity))
    participants = await client.get_participants(entity, aggressive=True)
    users = [_user_to_dict(u) for u in participants if not getattr(u, "deleted", False)]
    return _apply_filters(users, filters)


async def _parse_commenters(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: COMMENTERS -- iterate recent posts, get comment authors."""
    log.info("parse_mode_commenters", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}
    post_count = 0

    async for msg in client.iter_messages(entity, limit=100):
        if msg.replies and msg.replies.replies > 0:
            try:
                async for reply in client.iter_messages(entity, reply_to=msg.id, limit=50):
                    if reply.sender_id and reply.sender_id not in users:
                        try:
                            user = await client.get_entity(reply.sender_id)
                            if not getattr(user, "deleted", False):
                                users[reply.sender_id] = _user_to_dict(user)
                        except Exception as exc:
                            log.debug(
                                "commenters_get_entity_failed",
                                sender_id=reply.sender_id,
                                error=str(exc)[:200],
                            )
                    await asyncio.sleep(random.uniform(0.5, 2.0))
            except Exception as exc:
                log.debug(
                    "commenters_iter_replies_failed",
                    msg_id=msg.id,
                    error=str(exc)[:200],
                )
        post_count += 1
        if post_count % 10 == 0:
            await asyncio.sleep(random.uniform(1.0, 3.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_writers(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: WRITERS -- message authors in a chat."""
    log.info("parse_mode_writers", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}
    msg_count = 0

    async for msg in client.iter_messages(entity, limit=500):
        if msg.sender_id and msg.sender_id not in users:
            try:
                user = await client.get_entity(msg.sender_id)
                if not getattr(user, "deleted", False):
                    users[msg.sender_id] = _user_to_dict(user)
            except Exception as exc:
                log.debug(
                    "writers_get_entity_failed",
                    sender_id=msg.sender_id,
                    error=str(exc)[:200],
                )
        msg_count += 1
        if msg_count % 20 == 0:
            await asyncio.sleep(random.uniform(0.3, 1.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_reactions(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: REACTIONS -- users who reacted to recent posts."""
    from telethon.tl.functions.messages import GetMessageReactionsListRequest
    from telethon.tl.types import PeerUser

    log.info("parse_mode_reactions", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}
    post_count = 0

    async for msg in client.iter_messages(entity, limit=50):
        if not getattr(msg, "reactions", None):
            continue
        try:
            offset = ""
            while True:
                result = await client(GetMessageReactionsListRequest(
                    peer=entity,
                    id=msg.id,
                    limit=100,
                    offset=offset,
                ))
                for reaction in result.reactions:
                    # Skip anonymous/channel reactions (PeerChannel/PeerChat have no user_id)
                    if not isinstance(reaction.peer_id, PeerUser):
                        continue
                    uid = reaction.peer_id.user_id
                    if uid not in users:
                        try:
                            user = await client.get_entity(uid)
                            if not getattr(user, "deleted", False):
                                users[uid] = _user_to_dict(user)
                        except Exception:
                            pass
                        await asyncio.sleep(random.uniform(0.3, 1.0))
                if not result.next_offset:
                    break
                offset = result.next_offset
                await asyncio.sleep(random.uniform(1.0, 3.0))
        except Exception as exc:
            log.debug("reactions_error", msg_id=msg.id, error=str(exc)[:200])

        post_count += 1
        if post_count % 5 == 0:
            await asyncio.sleep(random.uniform(2.0, 5.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_polls(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: POLLS -- voters in polls found in recent messages."""
    from telethon.tl.functions.messages import GetPollVotersRequest

    log.info("parse_mode_polls", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}

    async for msg in client.iter_messages(entity, limit=100):
        if not getattr(msg, "media", None):
            continue
        poll = getattr(msg.media, "poll", None)
        if not poll:
            continue

        for i, answer in enumerate(poll.answers):
            try:
                offset = ""
                while True:
                    result = await client(GetPollVotersRequest(
                        peer=entity,
                        id=msg.id,
                        option=answer.option,
                        limit=100,
                        offset=offset,
                    ))
                    for voter in result.users:
                        if voter.id not in users and not getattr(voter, "deleted", False):
                            users[voter.id] = _user_to_dict(voter)
                    if not result.next_offset:
                        break
                    offset = result.next_offset
                    await asyncio.sleep(random.uniform(1.0, 2.0))
            except Exception as exc:
                log.debug("poll_voters_error", msg_id=msg.id, option=i, error=str(exc)[:200])

            await asyncio.sleep(random.uniform(0.5, 1.5))
        await asyncio.sleep(random.uniform(2.0, 5.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_joiners(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: JOINERS -- users who recently joined (from service messages)."""
    from telethon.tl.types import MessageActionChatAddUser, MessageActionChatJoinedByLink

    log.info("parse_mode_joiners", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}

    async for msg in client.iter_messages(entity, limit=1000):
        action = getattr(msg, "action", None)
        if not action:
            continue

        user_ids: list[int] = []
        if isinstance(action, MessageActionChatAddUser):
            user_ids = action.users
        elif isinstance(action, MessageActionChatJoinedByLink):
            if msg.sender_id:
                user_ids = [msg.sender_id]

        for uid in user_ids:
            if uid not in users:
                try:
                    user = await client.get_entity(uid)
                    if not getattr(user, "deleted", False):
                        users[uid] = _user_to_dict(user)
                except Exception:
                    pass
                await asyncio.sleep(random.uniform(0.3, 1.0))

        if len(users) % 50 == 0 and len(users) > 0:
            await asyncio.sleep(random.uniform(2.0, 5.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_topics(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: TOPICS -- participants of specific forum topics."""
    from telethon.tl.functions.channels import GetForumTopicsRequest

    log.info("parse_mode_topics", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}

    try:
        result = await client(GetForumTopicsRequest(
            channel=entity,
            offset_date=0,
            offset_id=0,
            offset_topic=0,
            limit=100,
        ))
        topics = result.topics
    except Exception as exc:
        log.warning("topics_not_forum", error=str(exc)[:200])
        return []

    for topic in topics:
        try:
            async for msg in client.iter_messages(entity, reply_to=topic.id, limit=200):
                if msg.sender_id and msg.sender_id not in users:
                    try:
                        user = await client.get_entity(msg.sender_id)
                        if not getattr(user, "deleted", False):
                            users[msg.sender_id] = _user_to_dict(user)
                    except Exception:
                        pass
                    await asyncio.sleep(random.uniform(0.3, 1.0))
        except Exception as exc:
            log.debug("topic_parse_error", topic_id=topic.id, error=str(exc)[:200])

        await asyncio.sleep(random.uniform(2.0, 5.0))

    return _apply_filters(list(users.values()), filters)


async def _parse_global_search(
    client: Any,
    entity: Any,
    filters: dict[str, Any],
) -> list[dict[str, Any]]:
    """Mode: GLOBAL_SEARCH -- search Telegram for users/channels by keywords."""
    from telethon.tl.functions.contacts import SearchRequest

    log.info("parse_mode_global_search", entity=str(entity))
    users: dict[int, dict[str, Any]] = {}

    keywords = filters.get("keywords", [])
    if isinstance(keywords, str):
        keywords = [k.strip() for k in keywords.split(",") if k.strip()]
    if not keywords:
        keywords = [getattr(entity, "title", "") or getattr(entity, "username", "") or "telegram"]

    for keyword in keywords[:10]:
        try:
            result = await client(SearchRequest(q=keyword, limit=100))
            for user in result.users:
                if user.id not in users and not getattr(user, "deleted", False) and not getattr(user, "bot", False):
                    users[user.id] = _user_to_dict(user)
        except Exception as exc:
            log.debug("global_search_error", keyword=keyword, error=str(exc)[:200])

        await asyncio.sleep(random.uniform(3.0, 8.0))

    return _apply_filters(list(users.values()), filters)


_MODE_HANDLERS: dict[str, Any] = {
    "CHAT_MEMBERS": _parse_chat_members,
    "COMMENTERS": _parse_commenters,
    "WRITERS": _parse_writers,
    "REACTIONS": _parse_reactions,
    "POLLS": _parse_polls,
    "JOINERS": _parse_joiners,
    "TOPICS": _parse_topics,
    "GLOBAL_SEARCH": _parse_global_search,
}


# ---------------------------------------------------------------------------
# Telethon client helper (identical pattern to warmup_tasks.py)
# ---------------------------------------------------------------------------

def _prepare_session(db: Any, account: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    """Decrypt session and resolve proxy kwargs for a given account.

    Returns (session_bytes, proxy_kwargs).
    Raises on failure.
    """
    # Decrypt session file
    session_path = Path(account["session_path"])
    if not session_path.exists():
        raise FileNotFoundError(f"Session file not found: {session_path}")

    session_bytes = decrypt_bytes(session_path.read_bytes())

    # Build proxy if assigned
    proxy_kwargs: dict[str, Any] = {}
    if account.get("proxy_id"):
        try:
            proxy_kwargs = _build_proxy_kwargs(db, account["proxy_id"])
            if proxy_kwargs:
                log.info(
                    "parsing_using_proxy",
                    account_id=account["id"],
                    proxy_id=account["proxy_id"],
                )
        except Exception as exc:
            log.warning(
                "parsing_proxy_load_failed",
                account_id=account["id"],
                error=str(exc),
            )

    return session_bytes, proxy_kwargs


def _get_api_credentials(account: dict[str, Any]) -> tuple[int, str]:
    """Extract app_id and app_hash from account metadata.

    Raises ValueError when credentials are missing.
    """
    meta: dict[str, Any] = {}
    if account.get("metadata"):
        try:
            meta = json.loads(account["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        raise ValueError("app_id/app_hash missing in account metadata")

    return int(app_id), str(app_hash)


# ---------------------------------------------------------------------------
# Core async parsing implementation
# ---------------------------------------------------------------------------

async def _parse_audience_async(workspace_id: str, task_id: str) -> dict[str, Any]:
    """Execute the full audience parsing pipeline (async)."""
    from telethon import TelegramClient  # type: ignore[import-untyped]
    from telethon.errors import (  # type: ignore[import-untyped]
        AuthKeyUnregisteredError,
        ChannelPrivateError,
        FloodWaitError,
        UserDeactivatedBanError,
    )

    db = get_db(workspace_id)

    # ── Load parsing task ──────────────────────────────────────────────
    task_row = db.execute(
        "SELECT * FROM tg_parsing_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not task_row:
        return {"status": "FAILED", "error": "Parsing task not found"}

    if task_row["status"] != "RUNNING":
        return {
            "status": "FAILED",
            "error": f"Task status is {task_row['status']}, expected RUNNING",
        }

    mode = task_row["mode"]
    handler = _MODE_HANDLERS.get(mode)
    if not handler:
        _fail_task(db, task_id, f"Unknown parsing mode: {mode}")
        return {"status": "FAILED", "error": f"Unknown parsing mode: {mode}"}

    # ── Parse config ───────────────────────────────────────────────────
    try:
        config = json.loads(task_row["config"]) if task_row["config"] else {}
    except json.JSONDecodeError:
        _fail_task(db, task_id, "Invalid JSON in task config")
        return {"status": "FAILED", "error": "Invalid JSON in task config"}

    sources: list[str] = config.get("sources", [])
    filters: dict[str, Any] = config.get("filters", {})

    if not sources:
        _fail_task(db, task_id, "No sources specified in config")
        return {"status": "FAILED", "error": "No sources specified"}

    # ── Resolve or create audience ─────────────────────────────────────
    audience_id = task_row["audience_id"]
    if not audience_id:
        audience_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO tg_audiences (id, name, description, source_type, created_at, updated_at)
               VALUES (?, ?, ?, 'PARSED', ?, ?)""",
            [
                audience_id,
                task_row["name"],
                f"Auto-created by parsing task {task_id}",
                _now(),
                _now(),
            ],
        )
        db.execute(
            "UPDATE tg_parsing_tasks SET audience_id = ?, updated_at = ? WHERE id = ?",
            [audience_id, _now(), task_id],
        )
        db.commit()

    # ── Pick an account ────────────────────────────────────────────────
    account = _pick_account(db)
    if not account:
        _fail_task(db, task_id, "No ACTIVE Telegram accounts available")
        return {"status": "FAILED", "error": "No active accounts"}

    log.info(
        "parse_audience_starting",
        workspace_id=workspace_id,
        task_id=task_id,
        mode=mode,
        sources_count=len(sources),
        account_id=account["id"],
    )

    # ── Decrypt session & prepare client ───────────────────────────────
    try:
        app_id, app_hash = _get_api_credentials(account)
    except ValueError as exc:
        _fail_task(db, task_id, str(exc))
        return {"status": "FAILED", "error": str(exc)}

    try:
        session_bytes, proxy_kwargs = _prepare_session(db, account)
    except Exception as exc:
        _fail_task(db, task_id, f"Session preparation failed: {exc}")
        return {"status": "FAILED", "error": f"Session preparation failed: {exc}"}

    # ── NO_PROXY guard: never connect over the server's real IP ─────────
    if "proxy" not in proxy_kwargs:
        log.warning("no_proxy_skip", account_id=account["id"], task_id=task_id)
        _fail_task(db, task_id, "NO_PROXY: нет активного прокси")
        return {"status": "FAILED", "error": "NO_PROXY: нет активного прокси"}

    # ── Write temp session for Telethon ────────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="tg_parse_")
    tmp_session_path = Path(tmp_dir) / "parse.session"
    tmp_session_path.write_bytes(session_bytes)

    total_found = 0
    total_filtered = 0
    source_errors: list[str] = []
    control_stop: str | None = None  # set to PAUSED/CANCELLED if stopped mid-run
    idx = 0

    try:
        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            api_id=app_id,
            api_hash=app_hash,
            **proxy_kwargs,
        )
        await client.connect()

        if not await client.is_user_authorized():
            db.execute(
                "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
                [_now(), account["id"]],
            )
            db.commit()
            _fail_task(db, task_id, "Account session not authorized -- marked DEAD")
            return {"status": "FAILED", "error": "Session not authorized"}

        # ── Iterate sources ────────────────────────────────────────────
        for idx, source in enumerate(sources):
            # Cooperative pause/cancel: stop before touching the next source.
            control_stop = _control_status(db, task_id)
            if control_stop:
                log.info(
                    "parse_control_stop",
                    task_id=task_id,
                    status=control_stop,
                    at_source=idx,
                    of=len(sources),
                )
                break

            source_label = source.strip().lstrip("@").replace("https://t.me/", "")
            log.info(
                "parse_source_starting",
                task_id=task_id,
                source=source,
                index=idx,
                total=len(sources),
            )

            try:
                entity = await client.get_entity(source)
                await asyncio.sleep(random.uniform(1.0, 3.0))

                users = await handler(client, entity, filters)
                found_count = len(users)
                total_found += found_count

                # Insert into audience
                inserted = _insert_members(db, audience_id, users, source_label)
                total_filtered += inserted

                log.info(
                    "parse_source_complete",
                    task_id=task_id,
                    source=source,
                    found=found_count,
                    inserted=inserted,
                )

            except ChannelPrivateError:
                err = f"Source '{source}' is private or inaccessible"
                log.warning("parse_source_private", source=source, task_id=task_id)
                source_errors.append(err)

            except FloodWaitError as exc:
                wait_seconds = getattr(exc, "seconds", 0)
                log.warning(
                    "parse_flood_wait",
                    source=source,
                    task_id=task_id,
                    wait_seconds=wait_seconds,
                    account_id=account["id"],
                )
                if wait_seconds > 300:
                    # Severe flood -- pause the account and fail the task
                    db.execute(
                        "UPDATE tg_accounts SET status = 'FLOOD_WAIT', updated_at = ? WHERE id = ?",
                        [_now(), account["id"]],
                    )
                    db.commit()
                    _fail_task(
                        db, task_id,
                        f"FloodWait {wait_seconds}s on source '{source}' -- account paused",
                    )
                    return {
                        "status": "FAILED",
                        "error": f"FloodWait {wait_seconds}s",
                        "total_found": total_found,
                        "total_filtered": total_filtered,
                    }
                # Short flood wait -- sleep and continue to next source
                await asyncio.sleep(min(wait_seconds + 5, 120))
                source_errors.append(f"FloodWait {wait_seconds}s on '{source}'")

            except AuthKeyUnregisteredError:
                db.execute(
                    "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
                    [_now(), account["id"]],
                )
                db.commit()
                _fail_task(db, task_id, "AuthKey unregistered -- account marked DEAD")
                return {"status": "FAILED", "error": "AuthKey unregistered"}

            except UserDeactivatedBanError as exc:
                db.execute(
                    """UPDATE tg_accounts
                       SET status = 'BANNED', banned_at = ?, ban_reason = ?, updated_at = ?
                       WHERE id = ?""",
                    [_now(), str(exc)[:200], _now(), account["id"]],
                )
                db.commit()
                _fail_task(db, task_id, f"Account banned: {exc}")
                return {"status": "FAILED", "error": f"Account banned: {exc}"}

            except Exception as exc:
                err = f"Error parsing source '{source}': {str(exc)[:200]}"
                log.warning("parse_source_error", source=source, error=str(exc)[:200])
                source_errors.append(err)

            # ── Update progress after each source ──────────────────────
            progress_pct = int(((idx + 1) / len(sources)) * 100)
            _update_task_progress(
                db, task_id,
                progress=progress_pct,
                total_found=total_found,
                total_filtered=total_filtered,
            )

            # Anti-ban delay between sources
            if idx < len(sources) - 1:
                await asyncio.sleep(random.uniform(2.0, 5.0))

        # ── Disconnect ─────────────────────────────────────────────────
        await client.disconnect()

    except FloodWaitError as exc:
        wait_seconds = getattr(exc, "seconds", 0)
        log.warning(
            "parse_flood_wait_global",
            task_id=task_id,
            wait_seconds=wait_seconds,
            account_id=account["id"],
        )
        db.execute(
            "UPDATE tg_accounts SET status = 'FLOOD_WAIT', updated_at = ? WHERE id = ?",
            [_now(), account["id"]],
        )
        db.commit()
        _fail_task(db, task_id, f"FloodWait {wait_seconds}s (global)")
        return {"status": "FAILED", "error": f"FloodWait {wait_seconds}s"}

    except AuthKeyUnregisteredError:
        db.execute(
            "UPDATE tg_accounts SET status = 'DEAD', updated_at = ? WHERE id = ?",
            [_now(), account["id"]],
        )
        db.commit()
        _fail_task(db, task_id, "AuthKey unregistered -- account marked DEAD")
        return {"status": "FAILED", "error": "AuthKey unregistered"}

    except Exception as exc:
        log.error(
            "parse_audience_crashed",
            task_id=task_id,
            workspace_id=workspace_id,
            error=str(exc),
            exc_info=True,
        )
        _fail_task(db, task_id, f"Unexpected error: {str(exc)[:500]}")
        return {"status": "FAILED", "error": f"Unexpected: {str(exc)[:300]}"}

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── Cooperative stop (pause/cancel mid-run) ────────────────────────
    # Persist partial results but DO NOT mark COMPLETED — the API already set
    # the status to PAUSED/CANCELLED, and _update_task_progress leaves it intact.
    if control_stop:
        _update_audience_counts(db, audience_id)
        _update_task_progress(
            db, task_id,
            progress=int((idx / len(sources)) * 100) if sources else 0,
            total_found=total_found,
            total_filtered=total_filtered,
        )
        log.info(
            "parse_audience_stopped",
            task_id=task_id,
            status=control_stop,
            sources_done=idx,
            total_found=total_found,
            total_filtered=total_filtered,
        )
        return {
            "status": control_stop,
            "stopped": True,
            "sources_done": idx,
            "total_found": total_found,
            "total_filtered": total_filtered,
        }

    # ── Finalize ───────────────────────────────────────────────────────
    _update_audience_counts(db, audience_id)
    _complete_task(db, task_id, total_found, total_filtered)

    log.info(
        "parse_audience_complete",
        workspace_id=workspace_id,
        task_id=task_id,
        audience_id=audience_id,
        total_found=total_found,
        total_filtered=total_filtered,
        source_errors=len(source_errors),
    )

    return {
        "status": "COMPLETED",
        "audience_id": audience_id,
        "total_found": total_found,
        "total_filtered": total_filtered,
        "source_errors": source_errors,
    }


# ---------------------------------------------------------------------------
# Celery task: parse_audience
# ---------------------------------------------------------------------------

@celery_app.task(name="pup_tg.parse_audience", bind=True, max_retries=0)
def parse_audience(self, workspace_id: str, task_id: str) -> dict[str, Any]:  # type: ignore[override]
    """Parse Telegram audience based on task config.

    This is a synchronous Celery task that internally runs the
    async Telethon pipeline via ``asyncio.run()``.
    """
    log.info(
        "parse_audience_task_started",
        workspace_id=workspace_id,
        task_id=task_id,
        celery_task_id=self.request.id,
    )
    try:
        return asyncio.run(_parse_audience_async(workspace_id, task_id))
    except Exception as exc:
        log.error(
            "parse_audience_task_crashed",
            workspace_id=workspace_id,
            task_id=task_id,
            error=str(exc),
            exc_info=True,
        )
        # Best-effort: mark the task as failed in DB
        try:
            db = get_db(workspace_id)
            _fail_task(db, task_id, f"Celery task crashed: {str(exc)[:500]}")
        except Exception:
            pass
        return {
            "status": "FAILED",
            "error": f"Task crashed: {str(exc)[:300]}",
            "total_found": 0,
            "total_filtered": 0,
        }
