"""Per-process client + entity cache for the web messenger (P6-03).

Previously every messenger request decrypted the session, opened a fresh MTProto
connection, fetched 100 dialogs to resolve the peer, and disconnected. This
module keeps a **connected client per account** (reused across requests) and a
**resolved-entity cache per (account, peer)**, with lazy idle eviction.

Guarantees preserved from the old path:
- **NO_PROXY guard** — a proxy-less account never connects over the real IP.
- Same error semantics (404 unknown account, 502 connect failure).

Lifecycle: callers obtain a client via :func:`get_messenger_client` and MUST NOT
disconnect it — the cache owns the connection and evicts it when idle. A cached
client that is found disconnected (network drop) is transparently rebuilt.

Single event loop assumed (uvicorn). A per-account lock serialises concurrent
connects for the same account so we never open two clients for one account.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import structlog
from fastapi import HTTPException, status

from app.telegram.client_pool import _connect_client, _load_account, _safe_disconnect

log = structlog.get_logger(__name__)

_IDLE_TTL = 300.0  # disconnect + drop a client idle longer than this (seconds)
_ENTITY_TTL = 600.0  # resolved-entity cache entry lifetime (seconds)

# account_id -> {"client": TelegramClient, "last": monotonic, "entities": {key: (entity, ts)}}
_cache: dict[str, dict[str, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()


async def _lock_for(account_id: str) -> asyncio.Lock:
    async with _locks_guard:
        lk = _locks.get(account_id)
        if lk is None:
            lk = asyncio.Lock()
            _locks[account_id] = lk
        return lk


async def _evict_idle(now: float) -> None:
    """Disconnect + drop clients idle longer than the TTL (lazy sweep)."""
    stale = [aid for aid, e in _cache.items() if now - e["last"] > _IDLE_TTL]
    for aid in stale:
        entry = _cache.pop(aid, None)
        if entry:
            await _safe_disconnect(entry["client"])
            log.info("messenger_client_evicted_idle", account_id=aid)


def _is_connected(client: Any) -> bool:
    try:
        return bool(client.is_connected())
    except Exception:  # noqa: BLE001
        return False


async def get_messenger_client(db: Any, account_id: str) -> Any:
    """Return a cached, connected client for *account_id* (reused across requests).

    Preserves the NO_PROXY guard and 404/502 error semantics. Rebuilds the
    client if the cached one is no longer connected. **Do not disconnect** the
    returned client — the cache owns its lifecycle.
    """
    now = time.monotonic()
    await _evict_idle(now)

    entry = _cache.get(account_id)
    if entry is not None and _is_connected(entry["client"]):
        entry["last"] = now
        return entry["client"]

    lock = await _lock_for(account_id)
    async with lock:
        # Re-check: another coroutine may have connected while we waited.
        entry = _cache.get(account_id)
        if entry is not None and _is_connected(entry["client"]):
            entry["last"] = time.monotonic()
            return entry["client"]
        if entry is not None:  # stale/dead → drop it
            await _safe_disconnect(entry["client"])
            _cache.pop(account_id, None)

        info = _load_account(db, account_id)
        if info is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Account '{account_id}' not found, not ACTIVE, or missing credentials",
            )
        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=account_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="NO_PROXY: у аккаунта нет активного прокси",
            )
        try:
            client = await _connect_client(info)
        except Exception as exc:  # noqa: BLE001
            log.error("messenger_client_connect_failed", account_id=account_id, error=str(exc)[:200])
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to connect Telegram account: {exc}",
            ) from exc
        _cache[account_id] = {"client": client, "last": time.monotonic(), "entities": {}}
        log.info("messenger_client_cached", account_id=account_id)
        return client


async def resolve_entity(
    db: Any, account_id: str, client: Any, peer_id: int | str, access_hash: str | int | None = None
) -> Any:
    """Resolve a peer to an entity, cached per (account, peer).

    On a miss, falls back to the messenger's dialog-scan + resolve. The cached
    entity is reused for ``_ENTITY_TTL`` seconds so repeated requests to the same
    chat skip the costly ``get_dialogs(100)`` round-trip.
    """
    now = time.monotonic()
    entry = _cache.get(account_id)
    ecache: dict[str, Any] = entry["entities"] if entry else {}
    key = f"{peer_id}|{access_hash or ''}"

    hit = ecache.get(key)
    if hit is not None and now - hit[1] < _ENTITY_TTL:
        return hit[0]

    # Lazy import to avoid a circular import at module load.
    from app.api.v1.telegram_client import _find_peer_entity

    entity = await _find_peer_entity(client, peer_id, access_hash)
    if entry is not None:
        ecache[key] = (entity, now)
    return entity


async def invalidate(account_id: str) -> None:
    """Drop + disconnect a cached client (e.g. after a fatal auth error)."""
    entry = _cache.pop(account_id, None)
    if entry:
        await _safe_disconnect(entry["client"])
        log.info("messenger_client_invalidated", account_id=account_id)
