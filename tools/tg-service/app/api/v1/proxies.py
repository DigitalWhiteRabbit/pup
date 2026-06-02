"""CRUD endpoints for the proxy pool."""

from __future__ import annotations

import asyncio
import json
import re
import socket
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/proxies", tags=["proxies"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ProxyCreate(BaseModel):
    provider: str = "manual"
    provider_order_id: str | None = None
    type: str = "DATACENTER"  # RESIDENTIAL|MOBILE|DATACENTER
    scheme: str = "socks5"  # http|socks5|mtproto
    host: str
    port: int
    username: str | None = None
    password: str | None = None
    country: str | None = None
    city: str | None = None
    expires_at: str | None = None
    rotation_url: str | None = None
    metadata: dict[str, Any] | None = None


class ProxyUpdate(BaseModel):
    provider: str | None = None
    provider_order_id: str | None = None
    type: str | None = None
    scheme: str | None = None
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = None
    country: str | None = None
    city: str | None = None
    status: str | None = None
    expires_at: str | None = None
    rotation_url: str | None = None
    metadata: dict[str, Any] | None = None


class ProxyResponse(BaseModel):
    id: str
    provider: str
    provider_order_id: str | None = None
    type: str
    scheme: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None
    country: str | None = None
    city: str | None = None
    status: str = "ACTIVE"
    last_checked_at: str | None = None
    last_latency_ms: int | None = None
    expires_at: str | None = None
    rotation_url: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: str | None = None
    updated_at: str | None = None


class BulkProxyImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str]


class ProxyCheckResult(BaseModel):
    id: str
    host: str
    port: int
    alive: bool
    latency_ms: int
    status: str
    error: str | None = None


class BulkProxyCheckResult(BaseModel):
    total: int
    alive: int
    dead: int
    results: list[ProxyCheckResult]


class BulkProxyDeleteRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)


class BulkProxyCreateRequest(BaseModel):
    proxies: list[ProxyCreate] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_proxy(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into a ProxyResponse-compatible dict."""
    data = dict(row)
    if data.get("metadata"):
        try:
            data["metadata"] = json.loads(data["metadata"])
        except (json.JSONDecodeError, TypeError):
            data["metadata"] = None
    else:
        data["metadata"] = None
    return data


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_URI_RE = re.compile(
    r"^(?P<scheme>socks5|socks4|http|https)://"
    r"(?:(?P<user>[^:@/]*)(?::(?P<pass>[^@/]*))?@)?"
    r"(?P<host>[^:/]+):(?P<port>\d+)",
    re.IGNORECASE,
)
_ROT_RE = re.compile(r"^https?://", re.IGNORECASE)


def _parse_proxy_line(line: str) -> dict[str, Any]:
    """Parse a proxy line into a dict of proxy fields.

    Supported formats:
    - ``host:port``
    - ``host:port:user:pass``
    - ``socks5://[user:pass@]host:port``
    - ``http://[user:pass@]host:port``
    - ``https://...`` URL without host:port → stored as rotation_url
    """
    line = line.strip()

    # URI format: scheme://[user:pass@]host:port
    m = _URI_RE.match(line)
    if m:
        scheme = m.group("scheme").lower()
        if scheme == "https":
            scheme = "http"
        return {
            "host": m.group("host"),
            "port": int(m.group("port")),
            "username": m.group("user") or None,
            "password": m.group("pass") or None,
            "scheme": scheme,
            "rotation_url": None,
        }

    # Rotation URL: bare https?:// endpoint (no parseable host:port at end)
    if _ROT_RE.match(line):
        return {
            "host": "rotating",
            "port": 0,
            "username": None,
            "password": None,
            "scheme": "http",
            "rotation_url": line,
        }

    # Legacy: host:port[:user[:pass]]
    parts = line.split(":")
    if len(parts) < 2:
        raise ValueError(f"Invalid proxy format: {line!r}")
    try:
        port = int(parts[1])
    except ValueError as exc:
        raise ValueError(f"Invalid port in: {line!r}") from exc
    return {
        "host": parts[0],
        "port": port,
        "username": parts[2] if len(parts) > 2 else None,
        "password": parts[3] if len(parts) > 3 else None,
        "scheme": None,
        "rotation_url": None,
    }


def _check_proxy_connectivity(host: str, port: int, timeout: float = 10.0) -> tuple[bool, int, str | None]:
    """Test TCP connectivity to a proxy endpoint.

    Returns (is_alive, latency_ms, error_message).
    """
    start = time.monotonic()
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.close()
        latency = int((time.monotonic() - start) * 1000)
        return True, latency, None
    except socket.timeout:
        return False, 0, "Connection timed out"
    except OSError as exc:
        return False, 0, str(exc)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class AutoAssignRequest(BaseModel):
    strategy: str = "equal_distribution"  # geo_matching | equal_distribution | fill_one_first
    only_active_proxies: bool = True
    dry_run: bool = True
    max_accounts_per_proxy: int = 3


class AutoAssignPreviewItem(BaseModel):
    account_id: str
    account_phone: str
    account_country: str | None
    proxy_id: str
    proxy_host: str
    proxy_country: str | None
    match_quality: str  # PERFECT | CLOSE | NO_MATCH


class AutoAssignResult(BaseModel):
    assigned: int
    preview: list[AutoAssignPreviewItem]


# ---------------------------------------------------------------------------
# Static-path routes (must come before /{proxy_id} to avoid path conflicts)
# ---------------------------------------------------------------------------


@router.get("/stats")
async def proxy_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return detailed proxy pool statistics."""

    all_statuses = ["ACTIVE", "DEAD", "PAUSED", "EXPIRED"]
    all_types = ["RESIDENTIAL", "MOBILE", "DATACENTER"]

    # by_status
    status_rows = db.execute(
        "SELECT status, COUNT(*) AS cnt FROM tg_proxies GROUP BY status"
    ).fetchall()
    by_status: dict[str, int] = {s: 0 for s in all_statuses}
    total = 0
    for r in status_rows:
        by_status[r["status"]] = r["cnt"]
        total += r["cnt"]

    # by_type
    type_rows = db.execute(
        "SELECT type, COUNT(*) AS cnt FROM tg_proxies GROUP BY type"
    ).fetchall()
    by_type: dict[str, int] = {t: 0 for t in all_types}
    for r in type_rows:
        by_type[r["type"]] = r["cnt"]

    # unchecked (never checked)
    unchecked_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_proxies WHERE last_checked_at IS NULL"
    ).fetchone()
    unchecked = unchecked_row["cnt"] if unchecked_row else 0

    # expiring_soon (within 7 days)
    expiring_row = db.execute(
        """SELECT COUNT(*) AS cnt FROM tg_proxies
           WHERE expires_at IS NOT NULL
             AND datetime(expires_at) <= datetime('now', '+7 days')
             AND datetime(expires_at) > datetime('now')"""
    ).fetchone()
    expiring_soon = expiring_row["cnt"] if expiring_row else 0

    # accounts per proxy stats
    acc_per_proxy_rows = db.execute(
        """SELECT p.id, COUNT(a.id) AS acc_cnt
           FROM tg_proxies p
           LEFT JOIN tg_accounts a ON a.proxy_id = p.id
           GROUP BY p.id"""
    ).fetchall()

    counts = [r["acc_cnt"] for r in acc_per_proxy_rows]
    without_accounts = sum(1 for c in counts if c == 0)
    avg_acc = round(sum(counts) / len(counts), 1) if counts else 0.0
    max_acc = max(counts) if counts else 0

    return {
        "total": total,
        "by_status": by_status,
        "by_type": by_type,
        "unchecked": unchecked,
        "expiring_soon": expiring_soon,
        "accounts_per_proxy": {
            "avg": avg_acc,
            "max": max_acc,
            "without_accounts": without_accounts,
        },
    }


@router.post("/auto-assign")
async def auto_assign_proxies(
    body: AutoAssignRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> AutoAssignResult:
    """Auto-assign proxies to accounts that have no proxy."""

    valid_strategies = {"geo_matching", "equal_distribution", "fill_one_first"}
    if body.strategy not in valid_strategies:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid strategy '{body.strategy}'. Must be one of: {', '.join(sorted(valid_strategies))}",
        )

    # 1. Get accounts without proxy
    unassigned = db.execute(
        "SELECT id, phone, country_code FROM tg_accounts WHERE proxy_id IS NULL ORDER BY created_at ASC"
    ).fetchall()

    if not unassigned:
        return AutoAssignResult(assigned=0, preview=[])

    # 2. Get available proxies
    proxy_condition = "WHERE status = 'ACTIVE'" if body.only_active_proxies else ""
    proxies = db.execute(
        f"SELECT id, host, port, country FROM tg_proxies {proxy_condition} ORDER BY created_at ASC"
    ).fetchall()

    if not proxies:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No available proxies found",
        )

    # 3. Count existing accounts per proxy
    load_rows = db.execute(
        """SELECT proxy_id, COUNT(*) AS cnt FROM tg_accounts
           WHERE proxy_id IS NOT NULL GROUP BY proxy_id"""
    ).fetchall()
    proxy_load: dict[str, int] = {r["proxy_id"]: r["cnt"] for r in load_rows}

    preview: list[AutoAssignPreviewItem] = []

    def _match_quality(acc_country: str | None, proxy_country: str | None) -> str:
        if not acc_country or not proxy_country:
            return "NO_MATCH"
        if acc_country.upper() == proxy_country.upper():
            return "PERFECT"
        # Close match: same first 2 chars (rough region heuristic) or CIS countries
        cis = {"RU", "KZ", "BY", "UA", "UZ", "KG", "TJ", "AM", "AZ", "MD", "GE"}
        if acc_country.upper() in cis and proxy_country.upper() in cis:
            return "CLOSE"
        return "NO_MATCH"

    if body.strategy == "geo_matching":
        # Group proxies by country for faster lookup
        proxies_by_country: dict[str, list[dict]] = {}
        proxies_no_country: list[dict] = []
        for p in proxies:
            c = (p["country"] or "").upper()
            if c:
                proxies_by_country.setdefault(c, []).append(dict(p))
            else:
                proxies_no_country.append(dict(p))

        for acc in unassigned:
            acc_country = (acc["country_code"] or "").upper()
            chosen = None
            quality = "NO_MATCH"

            # Try exact country match first
            if acc_country and acc_country in proxies_by_country:
                for p in proxies_by_country[acc_country]:
                    if proxy_load.get(p["id"], 0) < body.max_accounts_per_proxy:
                        chosen = p
                        quality = "PERFECT"
                        break

            # Try CIS close match
            if not chosen and acc_country:
                cis = {"RU", "KZ", "BY", "UA", "UZ", "KG", "TJ", "AM", "AZ", "MD", "GE"}
                if acc_country in cis:
                    for cis_c in cis:
                        if cis_c in proxies_by_country:
                            for p in proxies_by_country[cis_c]:
                                if proxy_load.get(p["id"], 0) < body.max_accounts_per_proxy:
                                    chosen = p
                                    quality = "CLOSE"
                                    break
                        if chosen:
                            break

            # Fallback: any proxy with capacity
            if not chosen:
                all_candidates = [dict(p) for p in proxies]
                for p in all_candidates:
                    if proxy_load.get(p["id"], 0) < body.max_accounts_per_proxy:
                        chosen = p
                        quality = "NO_MATCH"
                        break

            if not chosen:
                continue  # no proxy with capacity

            proxy_load[chosen["id"]] = proxy_load.get(chosen["id"], 0) + 1
            preview.append(AutoAssignPreviewItem(
                account_id=acc["id"],
                account_phone=acc["phone"],
                account_country=acc["country_code"],
                proxy_id=chosen["id"],
                proxy_host=chosen["host"],
                proxy_country=chosen["country"],
                match_quality=quality,
            ))

    elif body.strategy == "equal_distribution":
        proxy_list = [dict(p) for p in proxies]
        idx = 0
        for acc in unassigned:
            # Find next proxy with capacity (round-robin)
            attempts = 0
            while attempts < len(proxy_list):
                p = proxy_list[idx % len(proxy_list)]
                idx += 1
                if proxy_load.get(p["id"], 0) < body.max_accounts_per_proxy:
                    proxy_load[p["id"]] = proxy_load.get(p["id"], 0) + 1
                    preview.append(AutoAssignPreviewItem(
                        account_id=acc["id"],
                        account_phone=acc["phone"],
                        account_country=acc["country_code"],
                        proxy_id=p["id"],
                        proxy_host=p["host"],
                        proxy_country=p["country"],
                        match_quality=_match_quality(acc["country_code"], p["country"]),
                    ))
                    break
                attempts += 1
            # If all proxies are full, skip this account

    elif body.strategy == "fill_one_first":
        proxy_list = [dict(p) for p in proxies]
        proxy_idx = 0
        for acc in unassigned:
            # Find a proxy that still has capacity
            while proxy_idx < len(proxy_list):
                p = proxy_list[proxy_idx]
                if proxy_load.get(p["id"], 0) < body.max_accounts_per_proxy:
                    break
                proxy_idx += 1
            if proxy_idx >= len(proxy_list):
                break  # all proxies full

            p = proxy_list[proxy_idx]
            proxy_load[p["id"]] = proxy_load.get(p["id"], 0) + 1
            preview.append(AutoAssignPreviewItem(
                account_id=acc["id"],
                account_phone=acc["phone"],
                account_country=acc["country_code"],
                proxy_id=p["id"],
                proxy_host=p["host"],
                proxy_country=p["country"],
                match_quality=_match_quality(acc["country_code"], p["country"]),
            ))

    # Apply assignments if not dry_run
    if not body.dry_run and preview:
        now = _now()
        for item in preview:
            try:
                db.execute(
                    "UPDATE tg_accounts SET proxy_id = ?, updated_at = ? WHERE id = ?",
                    [item.proxy_id, now, item.account_id],
                )
            except Exception as exc:
                log.error("auto_assign_failed", account_id=item.account_id, error=str(exc))
        try:
            db.commit()
        except Exception:
            db.rollback()
            raise

        # Audit log
        try:
            db.execute(
                """INSERT INTO tg_audit_logs (event_type, severity, entity_type, message, metadata)
                   VALUES (?, ?, ?, ?, ?)""",
                [
                    "proxy.auto_assign",
                    "INFO",
                    "proxy",
                    f"Auto-assign ({body.strategy}): {len(preview)} accounts assigned",
                    json.dumps({"strategy": body.strategy, "assigned": len(preview)}),
                ],
            )
            db.commit()
        except Exception:
            pass

    log.info(
        "auto_assign_complete",
        strategy=body.strategy,
        dry_run=body.dry_run,
        assigned=len(preview),
    )

    return AutoAssignResult(assigned=len(preview), preview=preview)


@router.get("")
async def list_proxies(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    type_filter: str | None = Query(None, alias="type"),
    country: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List proxies with optional filtering and pagination."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        conditions.append("status = ?")
        params.append(status_filter)

    if type_filter:
        conditions.append("type = ?")
        params.append(type_filter)

    if country:
        conditions.append("country = ?")
        params.append(country)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_proxies {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_proxies {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_proxy(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{proxy_id}")
async def get_proxy(
    proxy_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single proxy by ID."""
    row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Proxy not found")
    return _row_to_proxy(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_proxy(
    body: ProxyCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new proxy entry."""
    now = _now()
    proxy_id = str(uuid.uuid4())
    metadata_json = json.dumps(body.metadata) if body.metadata else None

    try:
        db.execute(
            """
            INSERT INTO tg_proxies
                (id, provider, provider_order_id, type, scheme,
                 host, port, username, password, country, city,
                 expires_at, rotation_url, metadata,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                proxy_id, body.provider, body.provider_order_id, body.type,
                body.scheme, body.host, body.port, body.username, body.password,
                body.country, body.city, body.expires_at, body.rotation_url,
                metadata_json, now, now,
            ],
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        if "UNIQUE constraint failed" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Proxy {body.host}:{body.port} already exists",
            )
        raise

    row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    return _row_to_proxy(row)


@router.patch("/{proxy_id}")
async def update_proxy(
    proxy_id: str,
    body: ProxyUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update proxy fields. Only provided (non-None) fields are updated."""
    existing = db.execute(
        "SELECT id FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Proxy not found")

    updates: dict[str, Any] = {}
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "metadata" and value is not None:
            updates["metadata"] = json.dumps(value)
        else:
            updates[field] = value

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update"
        )

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [proxy_id]

    try:
        db.execute(
            f"UPDATE tg_proxies SET {set_clause} WHERE id = ?", values
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    return _row_to_proxy(row)


@router.delete("/{proxy_id}")
async def delete_proxy(
    proxy_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Delete a proxy, cascade-unbinding any accounts that reference it.

    Accounts referencing the proxy have their ``proxy_id`` set to NULL
    (cascade-unbind) before the proxy row is deleted. Leaving an account
    proxy-less is now safe: the NO_PROXY pre-connect guard refuses to
    connect such accounts (flagged "needs proxy") instead of leaking the
    server's real IP. Returns the number of detached accounts so the UI can
    surface it. Returns 404 if the proxy does not exist.
    """
    existing = db.execute(
        "SELECT id FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Proxy not found")

    try:
        unbound = db.execute(
            "SELECT COUNT(*) AS c FROM tg_accounts WHERE proxy_id = ?", [proxy_id]
        ).fetchone()["c"]
        db.execute(
            "UPDATE tg_accounts SET proxy_id = NULL, updated_at = ? WHERE proxy_id = ?",
            [_now(), proxy_id],
        )
        db.execute("DELETE FROM tg_proxies WHERE id = ?", [proxy_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("proxy_deleted", proxy_id=proxy_id, unbound_accounts=unbound)
    return {"status": "deleted", "id": proxy_id, "unbound_accounts": unbound}


@router.post("/bulk", status_code=status.HTTP_201_CREATED)
async def bulk_create_proxies(
    body: BulkProxyCreateRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> BulkProxyImportResult:
    """Bulk-create proxies from a JSON list of ProxyCreate objects.

    Used by the UI «Массовый импорт» dialog. Duplicates (host+port) are silently
    skipped; the response includes counts of imported, skipped, and any errors.
    """
    now = _now()
    imported = 0
    skipped = 0
    errors: list[str] = []

    for proxy in body.proxies:
        proxy_id = str(uuid.uuid4())
        metadata_json = json.dumps(proxy.metadata) if proxy.metadata else None
        try:
            db.execute(
                """
                INSERT INTO tg_proxies
                    (id, provider, provider_order_id, type, scheme,
                     host, port, username, password, country, city,
                     expires_at, rotation_url, metadata,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    proxy_id, proxy.provider, proxy.provider_order_id, proxy.type,
                    proxy.scheme, proxy.host, proxy.port, proxy.username, proxy.password,
                    proxy.country, proxy.city, proxy.expires_at, proxy.rotation_url,
                    metadata_json, now, now,
                ],
            )
            imported += 1
        except Exception as exc:
            if "UNIQUE constraint failed" in str(exc):
                skipped += 1
            else:
                errors.append(f"{proxy.host}:{proxy.port}: {exc}")

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        errors.append(f"commit failed: {exc}")

    log.info("proxies_bulk_created", imported=imported, skipped=skipped, errors=len(errors))
    return BulkProxyImportResult(imported=imported, skipped=skipped, errors=errors)


@router.post("/bulk-delete")
async def bulk_delete_proxies(
    body: BulkProxyDeleteRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Cascade-delete multiple proxies in a single atomic transaction.

    For each id: accounts referencing it are cascade-unbound (``proxy_id``
    set to NULL — safe via the NO_PROXY pre-connect guard) and the proxy row
    is deleted. Unknown ids are reported in ``not_found`` rather than raising.
    The whole batch commits once; on any error it rolls back and re-raises.

    Returns ``{"success": True, "deleted": X, "unbound_accounts": Y,
    "not_found": [...ids...]}``.
    """
    deleted = 0
    unbound_total = 0
    not_found: list[str] = []

    try:
        for proxy_id in body.ids:
            existing = db.execute(
                "SELECT id FROM tg_proxies WHERE id = ?", [proxy_id]
            ).fetchone()
            if not existing:
                not_found.append(proxy_id)
                continue

            unbound = db.execute(
                "SELECT COUNT(*) AS c FROM tg_accounts WHERE proxy_id = ?", [proxy_id]
            ).fetchone()["c"]
            db.execute(
                "UPDATE tg_accounts SET proxy_id = NULL, updated_at = ? WHERE proxy_id = ?",
                [_now(), proxy_id],
            )
            db.execute("DELETE FROM tg_proxies WHERE id = ?", [proxy_id])
            deleted += 1
            unbound_total += unbound

        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info(
        "proxies_bulk_deleted",
        deleted=deleted,
        unbound_accounts=unbound_total,
        not_found=len(not_found),
    )
    return {
        "success": True,
        "deleted": deleted,
        "unbound_accounts": unbound_total,
        "not_found": not_found,
    }


@router.post("/bulk-import")
async def bulk_import_proxies(
    body: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    provider: str = Query("manual"),
    type_: str = Query("DATACENTER", alias="type"),
    scheme: str = Query("socks5"),
    country: str | None = Query(None),
) -> BulkProxyImportResult:
    """Bulk-import proxies from a text block (one per line).

    Formats accepted:
    - ``host:port``
    - ``host:port:username:password``
    - ``socks5://[user:pass@]host:port``
    - ``http://[user:pass@]host:port``
    - ``https://rotation-endpoint/...`` (stored as rotation_url)
    """
    imported = 0
    skipped = 0
    errors: list[str] = []
    now = _now()

    lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]

    for idx, line in enumerate(lines):
        try:
            parsed = _parse_proxy_line(line)
        except (ValueError, IndexError) as exc:
            errors.append(f"[{idx}] {line}: {exc}")
            continue

        eff_scheme = parsed["scheme"] or scheme
        proxy_id = str(uuid.uuid4())
        try:
            db.execute(
                """
                INSERT INTO tg_proxies
                    (id, provider, type, scheme, host, port,
                     username, password, country, rotation_url,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    proxy_id, provider, type_, eff_scheme,
                    parsed["host"], parsed["port"],
                    parsed["username"], parsed["password"],
                    country, parsed["rotation_url"],
                    now, now,
                ],
            )
            imported += 1
        except Exception as exc:
            if "UNIQUE constraint failed" in str(exc):
                skipped += 1
            else:
                errors.append(f"[{idx}] {line}: {exc}")

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        errors.append(f"commit failed: {exc}")

    return BulkProxyImportResult(imported=imported, skipped=skipped, errors=errors)


@router.post("/{proxy_id}/check")
async def check_proxy(
    proxy_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Test real TCP connectivity to a proxy and update its status."""
    existing = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Proxy not found")

    host = existing["host"]
    port = existing["port"]

    # Run the blocking socket check in a thread to avoid blocking the event loop
    loop = asyncio.get_event_loop()
    alive, latency_ms, error = await loop.run_in_executor(
        None, _check_proxy_connectivity, host, port,
    )

    now = _now()
    new_status = "ACTIVE" if alive else "DEAD"

    try:
        db.execute(
            """UPDATE tg_proxies
               SET last_checked_at = ?, last_latency_ms = ?, status = ?, updated_at = ?
               WHERE id = ?""",
            [now, latency_ms, new_status, now, proxy_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info(
        "proxy_check_complete",
        proxy_id=proxy_id,
        host=host,
        port=port,
        alive=alive,
        latency_ms=latency_ms,
    )

    row = db.execute(
        "SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]
    ).fetchone()
    return _row_to_proxy(row)


@router.post("/check-all")
async def check_all_proxies(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> BulkProxyCheckResult:
    """Check all proxies with ACTIVE or unchecked status sequentially.

    Runs a TCP connectivity test for each proxy with a 1-second delay
    between checks to avoid overwhelming the network.
    """
    rows = db.execute(
        """SELECT * FROM tg_proxies
           WHERE status IN ('ACTIVE', 'IMPORTED') OR last_checked_at IS NULL
           ORDER BY created_at ASC"""
    ).fetchall()

    results: list[ProxyCheckResult] = []
    alive_count = 0
    dead_count = 0
    loop = asyncio.get_event_loop()

    for idx, proxy_row in enumerate(rows):
        proxy_id = proxy_row["id"]
        host = proxy_row["host"]
        port = proxy_row["port"]

        # Run connectivity check in thread pool
        alive, latency_ms, error = await loop.run_in_executor(
            None, _check_proxy_connectivity, host, port,
        )

        now = _now()
        new_status = "ACTIVE" if alive else "DEAD"

        try:
            db.execute(
                """UPDATE tg_proxies
                   SET last_checked_at = ?, last_latency_ms = ?, status = ?, updated_at = ?
                   WHERE id = ?""",
                [now, latency_ms, new_status, now, proxy_id],
            )
            db.commit()
        except Exception:
            db.rollback()

        if alive:
            alive_count += 1
        else:
            dead_count += 1

        results.append(ProxyCheckResult(
            id=proxy_id,
            host=host,
            port=port,
            alive=alive,
            latency_ms=latency_ms,
            status=new_status,
            error=error,
        ))

        # 1-second delay between checks (skip after last one)
        if idx < len(rows) - 1:
            await asyncio.sleep(1.0)

    log.info(
        "bulk_proxy_check_complete",
        total=len(rows),
        alive=alive_count,
        dead=dead_count,
    )

    return BulkProxyCheckResult(
        total=len(rows),
        alive=alive_count,
        dead=dead_count,
        results=results,
    )
