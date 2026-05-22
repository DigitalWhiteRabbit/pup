"""Proxy-Seller external API integration — manage keys, lists, balance, import proxies."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.deps import AdminAuth, WorkspaceDB

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/proxy-seller", tags=["proxy-seller"])

PROXY_SELLER_BASE = "https://proxy-seller.com/personal/api/v1"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class TestApiRequest(BaseModel):
    api_key: str


class TestApiResult(BaseModel):
    success: bool
    message: str
    balance: dict[str, Any] | None = None
    raw_preview: str | None = None


class SaveKeyRequest(BaseModel):
    api_key: str


class SaveKeyResult(BaseModel):
    success: bool
    message: str
    balance: dict[str, Any] | None = None


class ImportFromLinkRequest(BaseModel):
    link: str
    provider: str = "proxy-seller"
    type: str = "RESIDENTIAL"  # RESIDENTIAL | MOBILE | DATACENTER
    scheme: str = "http"  # http | socks5 | mtproto
    country: str | None = None


class ImportFromLinkResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str]
    lines_total: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_PROXY_LINE_PATTERNS: list[re.Pattern[str]] = [
    # ip:port@login:pass
    re.compile(r"^(?P<host>[^:]+):(?P<port>\d+)@(?P<user>[^:]+):(?P<passwd>.+)$"),
    # ip:port:login:pass
    re.compile(r"^(?P<host>[^:]+):(?P<port>\d+):(?P<user>[^:]+):(?P<passwd>.+)$"),
    # login:pass@ip:port
    re.compile(r"^(?P<user>[^:]+):(?P<passwd>[^@]+)@(?P<host>[^:]+):(?P<port>\d+)$"),
    # ip:port (no auth)
    re.compile(r"^(?P<host>[^:]+):(?P<port>\d+)$"),
]


def _parse_proxy_line(line: str) -> tuple[str, int, str | None, str | None]:
    """Parse a proxy line in various formats.

    Supported: ip:port@login:pass, ip:port:login:pass,
    login:pass@ip:port, ip:port.

    Returns (host, port, username, password).
    """
    stripped = line.strip()
    for pattern in _PROXY_LINE_PATTERNS:
        m = pattern.match(stripped)
        if m:
            groups = m.groupdict()
            return (
                groups["host"],
                int(groups["port"]),
                groups.get("user"),
                groups.get("passwd"),
            )
    raise ValueError(f"Unrecognized proxy format: {line}")


def _get_saved_api_key(db: Any) -> str | None:
    """Read the proxy_seller_api_key from tg_settings."""
    try:
        row = db.execute(
            "SELECT proxy_seller_api_key FROM tg_settings WHERE id = 'default'"
        ).fetchone()
        if row and row["proxy_seller_api_key"]:
            return row["proxy_seller_api_key"]
    except Exception:
        # Column may not exist in older DBs — graceful fallback
        pass
    return None


def _resolve_api_key(
    explicit_key: str | None,
    db: Any,
) -> str:
    """Resolve API key from explicit value or DB settings.

    Raises HTTPException if no key is available.
    """
    key = (explicit_key or "").strip()
    if key:
        return key
    saved = _get_saved_api_key(db)
    if saved:
        return saved
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="No Proxy-Seller API key provided and none saved in settings",
    )


async def _call_proxy_seller(
    api_key: str,
    path: str = "",
    *,
    timeout: float = 10.0,
) -> tuple[int, dict[str, Any] | str]:
    """Call Proxy-Seller API. Returns (status_code, parsed_json_or_text)."""
    url = f"{PROXY_SELLER_BASE}/{api_key}/residential/{path}".rstrip("/")
    log.info("proxy_seller_api_call", url=url)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url)
        try:
            data = resp.json()
        except Exception:
            data = resp.text
        return resp.status_code, data
    except httpx.RequestError as exc:
        log.error("proxy_seller_request_error", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to connect to Proxy-Seller API: {exc}",
        )


def _extract_balance(data: Any) -> dict[str, Any] | None:
    """Try to extract balance/bandwidth information from API response."""
    if not isinstance(data, dict):
        return None
    # The API may nest balance in various places — try common patterns
    for key in ("balance", "bandwidth", "traffic", "data"):
        if key in data:
            return {key: data[key]}
    # If it's a flat response with numeric fields, return as-is
    if any(isinstance(v, (int, float)) for v in data.values()):
        return data
    return data


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/test-api")
async def test_api(
    body: TestApiRequest,
    _token: AdminAuth,
) -> TestApiResult:
    """Test a Proxy-Seller API key by calling the residential endpoint.

    Returns success/failure with balance info if available.
    """
    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="api_key must not be empty",
        )

    status_code, data = await _call_proxy_seller(api_key)

    if status_code == 200:
        balance = _extract_balance(data) if isinstance(data, dict) else None
        preview = json.dumps(data, ensure_ascii=False)[:500] if data else None
        log.info("proxy_seller_test_ok", balance=balance)
        return TestApiResult(
            success=True,
            message="API key is valid. Connection successful.",
            balance=balance,
            raw_preview=preview,
        )
    elif status_code in (401, 403):
        return TestApiResult(
            success=False,
            message=f"API key is invalid or expired (HTTP {status_code})",
        )
    else:
        preview = (
            json.dumps(data, ensure_ascii=False)[:300]
            if isinstance(data, dict)
            else str(data)[:300]
        )
        return TestApiResult(
            success=False,
            message=f"Unexpected response from Proxy-Seller (HTTP {status_code})",
            raw_preview=preview,
        )


@router.post("/save-key")
async def save_key(
    body: SaveKeyRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> SaveKeyResult:
    """Validate and save a Proxy-Seller API key to workspace settings.

    Tests the key first. If valid, persists it to tg_settings.proxy_seller_api_key.
    If invalid, returns an error without saving.
    """
    api_key = body.api_key.strip()

    # Allow clearing the key
    if not api_key:
        try:
            db.execute(
                "UPDATE tg_settings SET proxy_seller_api_key = NULL, updated_at = ? WHERE id = 'default'",
                [_now()],
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        return SaveKeyResult(
            success=True,
            message="API key removed from settings",
        )

    # Test the key first
    status_code, data = await _call_proxy_seller(api_key)

    if status_code != 200:
        msg = f"API key validation failed (HTTP {status_code})"
        if status_code in (401, 403):
            msg = "API key is invalid or expired"
        return SaveKeyResult(success=False, message=msg)

    # Key is valid — save it
    try:
        db.execute(
            "UPDATE tg_settings SET proxy_seller_api_key = ?, updated_at = ? WHERE id = 'default'",
            [api_key, _now()],
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        log.error("proxy_seller_save_key_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save API key: {exc}",
        )

    balance = _extract_balance(data) if isinstance(data, dict) else None

    # Audit log
    try:
        db.execute(
            """INSERT INTO tg_audit_logs (event_type, severity, entity_type, message, metadata)
               VALUES (?, ?, ?, ?, ?)""",
            [
                "proxy_seller.key_saved",
                "INFO",
                "settings",
                "Proxy-Seller API key saved and validated",
                json.dumps({"key_prefix": api_key[:8] + "..."}),
            ],
        )
        db.commit()
    except Exception:
        pass

    log.info("proxy_seller_key_saved", key_prefix=api_key[:8])
    return SaveKeyResult(
        success=True,
        message="API key validated and saved successfully",
        balance=balance,
    )


@router.get("/lists")
async def get_lists(
    _token: AdminAuth,
    db: WorkspaceDB,
    api_key: str | None = Query(None),
) -> dict[str, Any]:
    """Fetch proxy lists from Proxy-Seller API.

    Returns whatever the API responds with — the exact format
    will be discovered from the live response.
    """
    resolved_key = _resolve_api_key(api_key, db)

    status_code, data = await _call_proxy_seller(resolved_key)

    if status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Proxy-Seller API returned HTTP {status_code}",
        )

    log.info(
        "proxy_seller_lists_fetched",
        response_type=type(data).__name__,
        response_keys=list(data.keys()) if isinstance(data, dict) else None,
    )

    return {
        "success": True,
        "data": data,
    }


@router.get("/balance")
async def get_balance(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Fetch balance/bandwidth info from Proxy-Seller using the saved API key."""
    saved_key = _get_saved_api_key(db)
    if not saved_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No Proxy-Seller API key saved in settings. Save one first via /proxy-seller/save-key.",
        )

    status_code, data = await _call_proxy_seller(saved_key)

    if status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Proxy-Seller API returned HTTP {status_code}",
        )

    balance = _extract_balance(data) if isinstance(data, dict) else None
    raw_preview = json.dumps(data, ensure_ascii=False)[:1000] if data else None

    log.info("proxy_seller_balance_fetched", balance=balance)

    return {
        "success": True,
        "balance": balance,
        "raw": raw_preview,
    }


@router.post("/import-from-link")
async def import_from_link(
    body: ImportFromLinkRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> ImportFromLinkResult:
    """Fetch a proxy list from a URL and import all proxies into the DB.

    The link should return a text file with one proxy per line.
    Supported line formats:
    - ip:port@login:pass
    - ip:port:login:pass
    - login:pass@ip:port
    - ip:port
    """
    valid_types = {"RESIDENTIAL", "MOBILE", "DATACENTER"}
    if body.type not in valid_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid proxy type '{body.type}'. Must be one of: {', '.join(sorted(valid_types))}",
        )

    # Fetch the proxy list from the link
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(body.link)
            resp.raise_for_status()
            content = resp.text
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Provider returned HTTP {exc.response.status_code}: {exc.response.text[:200]}",
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to fetch proxy list: {exc}",
        )

    lines = [ln.strip() for ln in content.strip().splitlines() if ln.strip()]

    if not lines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Proxy list is empty (no lines found in response)",
        )

    imported = 0
    skipped = 0
    errors: list[str] = []
    now = _now()

    for idx, line in enumerate(lines):
        try:
            host, port, username, password = _parse_proxy_line(line)
        except (ValueError, IndexError) as exc:
            errors.append(f"[{idx}] {line}: {exc}")
            continue

        proxy_id = str(uuid.uuid4())
        try:
            db.execute(
                """INSERT INTO tg_proxies
                    (id, provider, type, scheme, host, port,
                     username, password, country,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    proxy_id, body.provider, body.type, body.scheme,
                    host, port, username, password,
                    body.country, now, now,
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

    # Audit log
    try:
        db.execute(
            """INSERT INTO tg_audit_logs (event_type, severity, entity_type, message, metadata)
               VALUES (?, ?, ?, ?, ?)""",
            [
                "proxy.import_from_link",
                "INFO",
                "proxy",
                f"Proxy import from link: {imported} imported, {skipped} skipped, {len(errors)} errors",
                json.dumps({
                    "provider": body.provider,
                    "type": body.type,
                    "country": body.country,
                    "lines_total": len(lines),
                    "imported": imported,
                    "skipped": skipped,
                }),
            ],
        )
        db.commit()
    except Exception:
        pass

    log.info(
        "proxy_import_from_link",
        provider=body.provider,
        imported=imported,
        skipped=skipped,
        errors=len(errors),
    )

    return ImportFromLinkResult(
        imported=imported,
        skipped=skipped,
        errors=errors,
        lines_total=len(lines),
    )
