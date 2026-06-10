"""Telethon client pool — create connected TelegramClient instances on demand.

Used by FastAPI async endpoints (phone_checker, channels) to get a live
Telegram connection for a specific account or any available ACTIVE account.

Session files are AES-256-GCM encrypted on disk; they are decrypted into
a temporary directory for the duration of the connection.  Callers are
responsible for disconnecting the client when finished (or using it as an
async context manager).

Connection pattern mirrors ``app.tasks.dm_campaign_tasks._connect_account``.
"""

from __future__ import annotations

import json
import random
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

import structlog
from fastapi import HTTPException, status

from app.core.security import decrypt_bytes

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_proxy_kwargs(db: sqlite3.Connection, proxy_id: str) -> dict[str, Any]:
    """Load proxy from tg_proxies and return Telethon-compatible kwargs.

    Mirrors the identical helper in ``dm_campaign_tasks.py``.
    """
    import python_socks

    proxy_row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
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


def _load_account(db: sqlite3.Connection, account_id: str) -> dict[str, Any] | None:
    """Load an ACTIVE account row and prepare connection info.

    The AES-encrypted Telethon ``.session`` file is decrypted and converted to
    an in-memory ``StringSession`` string.  No plaintext session is ever left on
    disk: the temporary ``.session`` used during conversion is deleted before
    this function returns.

    Returns a dict with keys: account_id, phone, session_string, app_id,
    app_hash, twofa, proxy_kwargs — or None if the account is missing /
    inactive / lacks credentials.
    """
    from telethon.sessions import SQLiteSession, StringSession
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'",
        [account_id],
    ).fetchone()
    if not acc:
        return None

    meta = json.loads(acc["metadata"] or "{}")
    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        log.warning(
            "client_pool_missing_credentials",
            account_id=account_id,
            reason="app_id or app_hash missing in metadata",
        )
        return None

    # Decrypt session file
    session_path = Path(acc["session_path"])
    if not session_path.exists():
        log.error("client_pool_session_not_found", account_id=account_id, path=str(session_path))
        return None

    try:
        session_bytes = decrypt_bytes(session_path.read_bytes())
    except Exception as exc:
        log.error("client_pool_decrypt_failed", account_id=account_id, error=str(exc)[:200])
        return None

    # Convert the decrypted .session (SQLite) into an in-memory StringSession.
    # The temp .session file exists only for the duration of this conversion and
    # is removed in the finally block — nothing plaintext survives on disk.
    tmp_dir = tempfile.mkdtemp(prefix="tg_pool_")
    try:
        tmp_session = Path(tmp_dir) / "pool.session"
        tmp_session.write_bytes(session_bytes)
        sqlite_session = SQLiteSession(str(tmp_session.with_suffix("")))
        try:
            session_string = StringSession.save(sqlite_session)
        finally:
            sqlite_session.close()
    except Exception as exc:
        log.error(
            "client_pool_session_convert_failed",
            account_id=account_id,
            error=str(exc)[:200],
        )
        return None
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    proxy_kwargs = _build_proxy_kwargs(db, acc["proxy_id"]) if acc["proxy_id"] else {}

    return {
        "account_id": acc["id"],
        "phone": acc["phone"],
        "session_string": session_string,
        "app_id": int(app_id),
        "app_hash": str(app_hash),
        "twofa": meta.get("twoFA") or meta.get("twofa_password"),
        "proxy_kwargs": proxy_kwargs,
    }


async def _connect_client(info: dict[str, Any]) -> "TelegramClient":
    """Create a TelegramClient from an in-memory StringSession, connect, authorize.

    The session lives entirely in memory (StringSession); no session file is
    written to disk, so there is nothing to clean up on failure.  On failure the
    client is disconnected to avoid leaking the MTProto connection, then the
    exception is re-raised.
    """
    from telethon import TelegramClient
    from telethon.errors import (
        AuthKeyUnregisteredError,
        UserDeactivatedBanError,
    )
    from telethon.sessions import StringSession

    client = TelegramClient(
        StringSession(info["session_string"]),
        info["app_id"],
        info["app_hash"],
        timeout=30,
        connection_retries=5,
        retry_delay=2,
        **info["proxy_kwargs"],
    )

    try:
        await client.connect()

        if not await client.is_user_authorized():
            # An imported StringSession that is not authorized cannot be
            # recovered here: a 2FA password only applies during a full login
            # flow (code request + sign-in), and this service imports ready
            # sessions only (no SMS registration). Treat it as unusable.
            raise RuntimeError("Account session is not authorized")

        log.info(
            "client_pool_connected",
            account_id=info["account_id"],
            phone=info["phone"],
        )
        return client

    except (AuthKeyUnregisteredError, UserDeactivatedBanError) as exc:
        await _safe_disconnect(client)
        log.error(
            "client_pool_auth_fatal",
            account_id=info["account_id"],
            error=type(exc).__name__,
        )
        raise

    except Exception:
        await _safe_disconnect(client)
        raise


async def _safe_disconnect(client: "TelegramClient") -> None:
    """Disconnect a client, swallowing (and debug-logging) any error.

    Used so that connection-teardown failures never mask the primary
    response/error of the caller.
    """
    try:
        result = client.disconnect()
        if result is not None:
            await result
    except Exception as exc:
        log.debug("client_pool_disconnect_error", error=str(exc)[:200])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def disconnect_client(client: "TelegramClient | None") -> None:
    """Safely disconnect a pooled client (idempotent, error-swallowing).

    Callers that obtain a client via ``get_client_for_account`` /
    ``get_any_client`` MUST call this in a ``finally`` block to avoid leaking
    MTProto connections.  Accepts ``None`` so it can be called unconditionally.
    """
    if client is None:
        return
    await _safe_disconnect(client)


async def get_client_for_account(
    account_id: str,
    db: sqlite3.Connection,
) -> "TelegramClient":
    """Return a connected TelegramClient for a specific account.

    Parameters
    ----------
    account_id:
        UUID of the account in ``tg_accounts``.
    db:
        SQLite connection for the current workspace.

    Returns
    -------
    TelegramClient
        A connected, authorized Telethon client.

    Raises
    ------
    HTTPException 404
        Account not found or not ACTIVE.
    HTTPException 502
        Connection to Telegram failed.
    """
    info = _load_account(db, account_id)
    if info is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Account '{account_id}' not found, not ACTIVE, or missing credentials",
        )

    # NO_PROXY guard: never connect a proxy-less account over the server's real IP.
    if "proxy" not in info["proxy_kwargs"]:
        log.warning("no_proxy_skip", account_id=account_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NO_PROXY: у аккаунта нет активного прокси",
        )

    try:
        return await _connect_client(info)
    except Exception as exc:
        log.error(
            "client_pool_connect_failed",
            account_id=account_id,
            error=str(exc)[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to connect Telegram account: {exc}",
        )


async def get_any_client(
    db: sqlite3.Connection,
) -> "TelegramClient":
    """Return a connected TelegramClient using any available ACTIVE account.

    Only accounts that have an ACTIVE proxy assigned are considered: a
    proxy-less account must NEVER connect over the server's real IP.  Among
    equally qualified accounts the choice is random.

    Parameters
    ----------
    db:
        SQLite connection for the current workspace.

    Returns
    -------
    TelegramClient
        A connected, authorized Telethon client.

    Raises
    ------
    HTTPException 503
        No ACTIVE accounts exist in this workspace.
    HTTPException 502
        No ACTIVE account has an active proxy (NO_PROXY), or all candidate
        accounts with a proxy failed to connect.
    """
    rows = db.execute(
        "SELECT id, proxy_id FROM tg_accounts WHERE status = 'ACTIVE'"
    ).fetchall()

    if not rows:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No active Telegram accounts available in this workspace",
        )

    # Only consider accounts that have a proxy_id; the proxy must also be
    # ACTIVE (verified per-candidate below via _load_account's proxy_kwargs).
    # NO without-proxy fallback: a proxy-less account is never returned.
    candidates = [r["id"] for r in rows if r["proxy_id"]]
    random.shuffle(candidates)

    last_error: Exception | None = None
    for account_id in candidates:
        info = _load_account(db, account_id)
        if info is None:
            continue

        # NO_PROXY guard: skip accounts whose proxy is missing / not ACTIVE.
        if "proxy" not in info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=account_id)
            continue

        try:
            return await _connect_client(info)
        except Exception as exc:
            last_error = exc
            log.warning(
                "client_pool_candidate_failed",
                account_id=account_id,
                error=str(exc)[:200],
            )
            continue

    # All proxied candidates exhausted (or none had an active proxy).
    if last_error is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NO_PROXY: нет аккаунтов с активным прокси",
        )
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"All active accounts with a proxy failed to connect: {last_error}",
    )
