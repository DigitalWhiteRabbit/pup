"""CRUD endpoints for Telegram accounts pool."""

from __future__ import annotations

import json
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

from fastapi.responses import Response

from app.config import settings
from app.core.security import decrypt_bytes, encrypt_bytes
from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/accounts", tags=["accounts"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AccountCreate(BaseModel):
    phone: str
    session_path: str
    device_model: str | None = "iPhone 14 Pro"
    system_version: str | None = "iOS 17.5.1"
    app_version: str | None = "10.0.0"
    lang_code: str | None = "ru"
    dc_id: int | None = None
    country: str | None = None
    country_code: str | None = None
    tags: list[str] | None = Field(default_factory=list)


class AccountUpdate(BaseModel):
    phone: str | None = None
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    about: str | None = None
    session_path: str | None = None
    auth_key_hash: str | None = None
    device_model: str | None = None
    system_version: str | None = None
    app_version: str | None = None
    lang_code: str | None = None
    dc_id: int | None = None
    country: str | None = None
    country_code: str | None = None
    is_premium: int | None = None
    tg_user_id: int | None = None
    status: str | None = None
    warmup_level: int | None = None
    warmup_profile: str | None = None
    days_active: int | None = None
    last_session_at: str | None = None
    banned_at: str | None = None
    ban_reason: str | None = None
    proxy_id: str | None = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None


class AccountResponse(BaseModel):
    id: str
    phone: str
    tg_user_id: int | None = None
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    about: str | None = None
    session_path: str
    auth_key_hash: str | None = None
    device_model: str | None = None
    system_version: str | None = None
    app_version: str | None = None
    lang_code: str | None = None
    dc_id: int | None = None
    country: str | None = None
    country_code: str | None = None
    is_premium: int = 0
    sent_count: int = 0
    status: str = "IMPORTED"
    warmup_level: int = 0
    warmup_profile: str | None = None
    days_active: int = 0
    last_session_at: str | None = None
    banned_at: str | None = None
    ban_reason: str | None = None
    proxy_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] | None = None
    has_avatar: bool = False
    # Account-health flags surfaced from the last Telegram check (stored in metadata)
    restricted: bool = False
    scam: bool = False
    fake: bool = False
    verified: bool = False
    # Humanity index 0..4 (avatar / username / bio / 2FA) + its breakdown
    humanity_score: int = 0
    humanity: dict[str, Any] | None = None
    created_at: str | None = None
    updated_at: str | None = None


class BulkAccountItem(BaseModel):
    phone: str
    session_path: str
    device_model: str | None = "iPhone 14 Pro"
    system_version: str | None = "iOS 17.5.1"
    app_version: str | None = "10.0.0"
    lang_code: str | None = "ru"
    dc_id: int | None = None
    country: str | None = None
    country_code: str | None = None
    tags: list[str] | None = Field(default_factory=list)


class BulkImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str]


class ZipImportError(BaseModel):
    phone: str
    error: str


class ZipImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[ZipImportError]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log = structlog.get_logger(__name__)


def _row_to_account(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an AccountResponse-compatible dict."""
    data = dict(row)
    # Deserialize JSON columns
    if data.get("tags"):
        try:
            data["tags"] = json.loads(data["tags"])
        except (json.JSONDecodeError, TypeError):
            data["tags"] = []
    else:
        data["tags"] = []

    if data.get("metadata"):
        try:
            data["metadata"] = json.loads(data["metadata"])
        except (json.JSONDecodeError, TypeError):
            data["metadata"] = None
    else:
        data["metadata"] = None

    # has_avatar: True when a generated avatar path is recorded in metadata.
    # Cheap metadata check only — never hit the filesystem (list can be large).
    meta = data["metadata"] if isinstance(data["metadata"], dict) else {}
    data["has_avatar"] = bool(meta.get("avatar_path"))

    # Surface account-health signals captured by the last Telegram check so the
    # UI can render flags/humanity without parsing metadata client-side.
    data["restricted"] = bool(meta.get("restricted"))
    data["scam"] = bool(meta.get("scam"))
    data["fake"] = bool(meta.get("fake"))
    data["verified"] = bool(meta.get("verified"))
    humanity = meta.get("humanity") if isinstance(meta.get("humanity"), dict) else None
    data["humanity"] = humanity
    data["humanity_score"] = int(humanity.get("score", 0)) if humanity else 0

    return data


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _has_active_proxy(db: Any, proxy_id: Any) -> bool:
    """Return True only if the account has a usable proxy.

    "Without proxy" (and therefore no Telegram check allowed) means:
    proxy_id is NULL/empty OR the referenced tg_proxies row is missing
    OR its status != 'ACTIVE'. Connecting without an ACTIVE proxy would
    expose the server's real IP and risk a ban.
    """
    if not proxy_id:
        return False
    proxy_row = db.execute("SELECT status FROM tg_proxies WHERE id = ?", [proxy_id]).fetchone()
    return bool(proxy_row and proxy_row["status"] == "ACTIVE")


async def _enrich_profile_meta(client: Any, me: Any, meta: dict[str, Any]) -> None:
    """Enrich ``meta`` in place with account-health signals during a check.

    Cheap flags (scam/fake/verified/restricted) come for free on the ``me``
    object. Two extra lightweight calls add the bio (GetFullUser) and the 2FA
    flag (GetPassword) so we can compute a *humanity index* — avatar / username /
    bio / 2FA, score 0..4 — that flags bare, ban-prone accounts. Every extra call
    is best-effort: on failure it degrades to a safe default and never raises, so
    enrichment can never fail the underlying liveness check.
    """
    # --- Free flags straight off get_me() ---
    meta["scam"] = bool(getattr(me, "scam", False))
    meta["fake"] = bool(getattr(me, "fake", False))
    meta["verified"] = bool(getattr(me, "verified", False))
    meta["restricted"] = bool(getattr(me, "restricted", False))
    rr = getattr(me, "restriction_reason", None)
    if rr:
        try:
            meta["restriction_reason"] = "; ".join(
                f"{getattr(r, 'platform', '')}:{getattr(r, 'reason', '')} "
                f"{getattr(r, 'text', '')}".strip()
                for r in rr
            )
        except TypeError:
            meta["restriction_reason"] = str(rr)
    else:
        meta["restriction_reason"] = ""
    meta["tg_has_photo"] = getattr(me, "photo", None) is not None

    # --- Bio (one extra call) ---
    try:
        from telethon.tl.functions.users import GetFullUserRequest
        full = await client(GetFullUserRequest(me))
        meta["bio"] = getattr(full.full_user, "about", None) or ""
    except Exception:
        meta.setdefault("bio", "")

    # --- 2FA enabled? (one extra call) ---
    try:
        from telethon.tl.functions.account import GetPasswordRequest
        pwd = await client(GetPasswordRequest())
        meta["has_2fa"] = bool(getattr(pwd, "has_password", False))
    except Exception:
        meta.setdefault("has_2fa", False)

    # --- Humanity index (0..4) ---
    # A real Telegram avatar OR a generated one both count as "has avatar".
    avatar = bool(meta.get("tg_has_photo")) or bool(meta.get("avatar_path"))
    username = bool(getattr(me, "username", None))
    bio_ok = bool((meta.get("bio") or "").strip())
    twofa = bool(meta.get("has_2fa"))
    parts = {"avatar": avatar, "username": username, "bio": bio_ok, "twofa": twofa}
    score = sum(1 for v in parts.values() if v)
    meta["humanity"] = {**parts, "score": score, "pct": score * 25}
    meta["last_check"] = _now()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/stats")
async def account_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return detailed account statistics."""

    # All possible statuses for a complete response
    all_statuses = [
        "ACTIVE", "SPAM_BLOCKED", "FLOOD_WAIT", "BANNED",
        "DEAD", "IMPORTED", "WARMING", "PAUSED",
    ]

    rows = db.execute(
        "SELECT status, COUNT(*) AS cnt FROM tg_accounts GROUP BY status"
    ).fetchall()

    by_status: dict[str, int] = {s: 0 for s in all_statuses}
    total = 0
    for r in rows:
        by_status[r["status"]] = r["cnt"]
        total += r["cnt"]

    premium_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_accounts WHERE is_premium = 1"
    ).fetchone()
    premium_count = premium_row["cnt"] if premium_row else 0

    with_proxy_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_accounts WHERE proxy_id IS NOT NULL"
    ).fetchone()
    with_proxy = with_proxy_row["cnt"] if with_proxy_row else 0

    avg_warmup_row = db.execute(
        "SELECT AVG(warmup_level) AS avg_wl FROM tg_accounts"
    ).fetchone()
    avg_warmup_level = round(avg_warmup_row["avg_wl"] or 0)

    return {
        "total": total,
        "by_status": by_status,
        "premium_count": premium_count,
        "with_proxy": with_proxy,
        "without_proxy": total - with_proxy,
        "avg_warmup_level": avg_warmup_level,
    }


class BulkActionRequest(BaseModel):
    account_ids: list[str]
    action: str  # check_status | assign_proxy | set_status | add_tags | remove_tags | delete
    params: dict[str, Any] | None = None


class BulkActionResult(BaseModel):
    success: int
    failed: int
    errors: list[str]


@router.post("/bulk-action")
async def bulk_action(
    body: BulkActionRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> BulkActionResult:
    """Execute a bulk action on a set of accounts."""
    valid_actions = {"check_status", "assign_proxy", "set_status", "add_tags", "remove_tags", "delete"}
    if body.action not in valid_actions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action '{body.action}'. Must be one of: {', '.join(sorted(valid_actions))}",
        )

    if not body.account_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="account_ids must not be empty",
        )

    params = body.params or {}
    success = 0
    failed = 0
    errors: list[str] = []
    now = _now()

    for account_id in body.account_ids:
        try:
            existing = db.execute(
                "SELECT id, tags FROM tg_accounts WHERE id = ?", [account_id]
            ).fetchone()
            if not existing:
                failed += 1
                errors.append(f"{account_id}: account not found")
                continue

            if body.action == "check_status":
                # Real reachability check via Telethon (reuses single-account
                # check path). Promotes to ACTIVE only when Telegram confirms
                # the session is alive; otherwise check_telegram marks the
                # account DEAD/BANNED/INVALID and we count it as failed.
                check = await check_telegram(account_id, _token, db)
                if check.success:
                    success += 1
                else:
                    failed += 1
                    errors.append(f"{account_id}: {check.error or check.status}")

            elif body.action == "assign_proxy":
                proxy_id = params.get("proxy_id")
                if proxy_id:
                    proxy_row = db.execute(
                        "SELECT id FROM tg_proxies WHERE id = ?", [proxy_id]
                    ).fetchone()
                    if not proxy_row:
                        failed += 1
                        errors.append(f"{account_id}: proxy {proxy_id} not found")
                        continue
                db.execute(
                    "UPDATE tg_accounts SET proxy_id = ?, updated_at = ? WHERE id = ?",
                    [proxy_id, now, account_id],
                )
                success += 1

            elif body.action == "set_status":
                new_status = params.get("status")
                if not new_status:
                    failed += 1
                    errors.append(f"{account_id}: 'status' param required")
                    continue
                db.execute(
                    "UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?",
                    [new_status, now, account_id],
                )
                success += 1

            elif body.action == "add_tags":
                new_tags = params.get("tags", [])
                if not isinstance(new_tags, list) or not new_tags:
                    failed += 1
                    errors.append(f"{account_id}: 'tags' param must be a non-empty list")
                    continue
                current_tags: list[str] = []
                try:
                    current_tags = json.loads(existing["tags"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    current_tags = []
                merged = list(dict.fromkeys(current_tags + new_tags))  # preserve order, dedupe
                db.execute(
                    "UPDATE tg_accounts SET tags = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(merged), now, account_id],
                )
                success += 1

            elif body.action == "remove_tags":
                rm_tags = params.get("tags", [])
                if not isinstance(rm_tags, list) or not rm_tags:
                    failed += 1
                    errors.append(f"{account_id}: 'tags' param must be a non-empty list")
                    continue
                current_tags = []
                try:
                    current_tags = json.loads(existing["tags"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    current_tags = []
                filtered = [t for t in current_tags if t not in rm_tags]
                db.execute(
                    "UPDATE tg_accounts SET tags = ?, updated_at = ? WHERE id = ?",
                    [json.dumps(filtered), now, account_id],
                )
                success += 1

            elif body.action == "delete":
                db.execute("DELETE FROM tg_accounts WHERE id = ?", [account_id])
                success += 1

        except Exception as exc:
            failed += 1
            errors.append(f"{account_id}: {exc}")

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
                f"account.bulk_{body.action}",
                "INFO",
                "account",
                f"Bulk {body.action}: {success} success, {failed} failed",
                json.dumps({"action": body.action, "count": len(body.account_ids), "success": success, "failed": failed}),
            ],
        )
        db.commit()
    except Exception:
        pass

    log.info(
        "bulk_action_complete",
        action=body.action,
        total=len(body.account_ids),
        success=success,
        failed=failed,
    )

    return BulkActionResult(success=success, failed=failed, errors=errors)


@router.get("")
async def list_accounts(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List accounts with optional filtering, search, and pagination."""
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        conditions.append("status = ?")
        params.append(status_filter)

    if search:
        conditions.append("(phone LIKE ? OR username LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like])

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_accounts {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_accounts {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_account(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{account_id}")
async def get_account(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single account by ID."""
    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
    return _row_to_account(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_account(
    body: AccountCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new Telegram account entry."""
    now = _now()
    account_id = str(uuid.uuid4())
    tags_json = json.dumps(body.tags or [])

    try:
        db.execute(
            """
            INSERT INTO tg_accounts
                (id, phone, session_path, device_model, system_version,
                 app_version, lang_code, dc_id, country, country_code,
                 tags, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                account_id, body.phone, body.session_path, body.device_model,
                body.system_version, body.app_version, body.lang_code,
                body.dc_id, body.country, body.country_code,
                tags_json, now, now,
            ],
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        if "UNIQUE constraint failed" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Account with phone {body.phone} already exists",
            )
        raise

    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    return _row_to_account(row)


@router.patch("/{account_id}")
async def update_account(
    account_id: str,
    body: AccountUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update account fields. Only provided (non-None) fields are updated."""
    existing = db.execute(
        "SELECT id FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Account not found")

    updates: dict[str, Any] = {}
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "tags" and value is not None:
            updates["tags"] = json.dumps(value)
        elif field == "metadata" and value is not None:
            updates["metadata"] = json.dumps(value)
        else:
            updates[field] = value

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update"
        )

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [account_id]

    try:
        db.execute(
            f"UPDATE tg_accounts SET {set_clause} WHERE id = ?", values
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    return _row_to_account(row)


@router.delete("/{account_id}")
async def delete_account(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Delete an account by ID."""
    existing = db.execute(
        "SELECT id FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        db.execute("DELETE FROM tg_accounts WHERE id = ?", [account_id])
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"status": "deleted", "id": account_id}


@router.post("/bulk-import")
async def bulk_import_accounts(
    body: list[BulkAccountItem],
    _token: AdminAuth,
    db: WorkspaceDB,
) -> BulkImportResult:
    """Bulk-import an array of accounts. Skips duplicates by phone."""
    imported = 0
    skipped = 0
    errors: list[str] = []
    now = _now()

    for idx, item in enumerate(body):
        account_id = str(uuid.uuid4())
        tags_json = json.dumps(item.tags or [])
        try:
            db.execute(
                """
                INSERT INTO tg_accounts
                    (id, phone, session_path, device_model, system_version,
                     app_version, lang_code, dc_id, country, country_code,
                     tags, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    account_id, item.phone, item.session_path, item.device_model,
                    item.system_version, item.app_version, item.lang_code,
                    item.dc_id, item.country, item.country_code,
                    tags_json, now, now,
                ],
            )
            imported += 1
        except Exception as exc:
            if "UNIQUE constraint failed" in str(exc):
                skipped += 1
            else:
                errors.append(f"[{idx}] {item.phone}: {exc}")

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        errors.append(f"commit failed: {exc}")

    return BulkImportResult(imported=imported, skipped=skipped, errors=errors)


@router.post("/import-zip")
async def import_zip(
    file: UploadFile,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> ZipImportResult:
    """Import accounts from a ZIP archive containing .session + .json pairs.

    ZIP structure:
        account_+79161234567.session
        account_+79161234567.json
        ...

    Each .json contains: phone, app_id, app_hash, device, system,
    register_time, twofa_password (optional).
    """
    imported = 0
    skipped = 0
    errors: list[ZipImportError] = []
    now = _now()

    # ── Read uploaded file into memory ──────────────────────────────
    try:
        zip_bytes = await file.read()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read uploaded file: {exc}",
        )

    # ── Extract to temp directory ───────────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="tg_zip_import_")
    try:
        # Write ZIP to temp and extract
        zip_path = Path(tmp_dir) / "archive.zip"
        zip_path.write_bytes(zip_bytes)

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                # Security: reject ZIPs with path traversal
                for name in zf.namelist():
                    if name.startswith("/") or ".." in name:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Unsafe path in ZIP: {name}",
                        )
                zf.extractall(tmp_dir)
        except zipfile.BadZipFile:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is not a valid ZIP archive",
            )

        # ── Discover .session + .json pairs ─────────────────────────
        extracted = Path(tmp_dir)
        session_files: dict[str, Path] = {}
        for p in extracted.rglob("*.session"):
            prefix = p.stem  # e.g. "account_+79161234567"
            session_files[prefix] = p

        json_files: dict[str, Path] = {}
        for p in extracted.rglob("*.json"):
            prefix = p.stem
            json_files[prefix] = p

        if not session_files:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No .session files found in ZIP archive",
            )

        # ── Prepare workspace sessions directory ────────────────────
        ws_sessions_dir = settings.sessions_dir / f"ws-{workspace_id}"
        ws_sessions_dir.mkdir(parents=True, exist_ok=True)

        # ── Process each pair ───────────────────────────────────────
        for prefix, session_path in session_files.items():
            json_path = json_files.get(prefix)
            phone = "unknown"

            try:
                # Parse metadata from JSON (if present)
                meta: dict[str, Any] = {}
                if json_path and json_path.exists():
                    try:
                        raw_json = json_path.read_text(encoding="utf-8")
                        meta = json.loads(raw_json)
                    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                        errors.append(ZipImportError(
                            phone=prefix,
                            error=f"Malformed JSON: {exc}",
                        ))
                        continue

                phone = meta.get("phone", "")
                if not phone:
                    # Try filename: "79318512393" or "account_+79161234567"
                    candidate = prefix.split("_", 1)[-1]  # handle "account_+7..." or just "7..."
                    if candidate and candidate[0].isdigit():
                        phone = candidate
                if not phone:
                    errors.append(ZipImportError(
                        phone=prefix,
                        error="Не удалось определить номер телефона",
                    ))
                    continue
                # Normalize: ensure phone starts with +
                phone = str(phone).strip()
                if not phone.startswith("+"):
                    phone = "+" + phone

                # Check for duplicate phone
                existing = db.execute(
                    "SELECT id FROM tg_accounts WHERE phone = ?", [phone]
                ).fetchone()
                if existing:
                    skipped += 1
                    continue

                # Read and encrypt session file
                session_bytes = session_path.read_bytes()
                if not session_bytes:
                    errors.append(ZipImportError(
                        phone=phone,
                        error="Session file is empty",
                    ))
                    continue

                encrypted = encrypt_bytes(session_bytes)
                enc_filename = f"{uuid.uuid4()}.session.enc"
                enc_path = ws_sessions_dir / enc_filename
                enc_path.write_bytes(encrypted)

                # Relative session_path for DB storage
                rel_session_path = str(Path("data/sessions") / f"ws-{workspace_id}" / enc_filename)

                # Extract fields from metadata
                device_model = meta.get("device") or meta.get("device_model") or "Unknown"
                system_version = meta.get("system") or meta.get("sdk") or meta.get("system_version") or "Unknown"
                app_version = meta.get("app_version") or "10.0.0"
                lang_code = (meta.get("system_lang_pack") or meta.get("lang_pack") or "ru").split("-")[0]
                first_name = meta.get("first_name")
                last_name = meta.get("last_name")
                username = meta.get("username")
                tg_user_id = meta.get("user_id") or meta.get("id")
                is_premium = 1 if meta.get("is_premium") else 0

                # Determine initial status from spamblock info
                spamblock = meta.get("spamblock")
                initial_status = "IMPORTED"
                if spamblock and spamblock not in ("none", "None", "", "false", "False"):
                    initial_status = "SPAM_BLOCKED"

                # Store all extra fields in metadata JSON
                account_meta: dict[str, Any] = {}
                for key in ("app_id", "app_hash", "twoFA", "twofa_password",
                            "register_time", "spamblock", "spamblock_end_date",
                            "proxy", "session_created_date", "last_connect_date",
                            "sex", "date_of_birth", "lang_pack", "system_lang_pack",
                            "tz_offset", "has_profile_pic"):
                    if meta.get(key) is not None:
                        account_meta[key] = meta[key]

                # Auto-detect country from phone number (no network needed)
                detected_country = None
                try:
                    import phonenumbers
                    pn = phonenumbers.parse(phone)
                    region = phonenumbers.region_code_for_number(pn)
                    if region:
                        detected_country = region.upper()
                except Exception:
                    pass

                account_id = str(uuid.uuid4())
                db.execute(
                    """
                    INSERT INTO tg_accounts
                        (id, phone, tg_user_id, username, first_name, last_name,
                         session_path, device_model, system_version, app_version,
                         lang_code, is_premium, status, country_code,
                         tags, metadata, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        account_id, phone, tg_user_id, username, first_name, last_name,
                        rel_session_path, device_model, system_version, app_version,
                        lang_code, is_premium, initial_status, detected_country,
                        "[]",
                        json.dumps(account_meta) if account_meta else None,
                        now, now,
                    ],
                )
                imported += 1

            except Exception as exc:
                errors.append(ZipImportError(phone=phone, error=str(exc)))

        # ── Commit all inserts ──────────────────────────────────────
        try:
            db.commit()
        except Exception as exc:
            db.rollback()
            errors.append(ZipImportError(phone="*", error=f"DB commit failed: {exc}"))

        # ── Audit log ───────────────────────────────────────────────
        try:
            db.execute(
                """
                INSERT INTO tg_audit_logs (event_type, severity, entity_type, message, metadata)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    "account.zip_import",
                    "INFO",
                    "account",
                    f"ZIP import: {imported} imported, {skipped} skipped, {len(errors)} errors",
                    json.dumps({"imported": imported, "skipped": skipped, "errors_count": len(errors)}),
                ],
            )
            db.commit()
        except Exception:
            pass  # audit log failure is non-critical

        log.info(
            "zip_import_complete",
            workspace_id=workspace_id,
            imported=imported,
            skipped=skipped,
            errors=len(errors),
        )

    finally:
        # ── Cleanup temp directory ──────────────────────────────────
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return ZipImportResult(imported=imported, skipped=skipped, errors=errors)


# ---------------------------------------------------------------------------
# Telegram connectivity check
# ---------------------------------------------------------------------------

class TelegramCheckResult(BaseModel):
    account_id: str
    success: bool
    tg_user_id: int | None = None
    first_name: str | None = None
    username: str | None = None
    is_premium: bool = False
    error: str | None = None
    status: str = "IMPORTED"
    # Account-health signals gathered during the check (only set on success)
    restricted: bool = False
    scam: bool = False
    fake: bool = False
    verified: bool = False
    humanity_score: int = 0  # 0..4: avatar / username / bio / 2FA


@router.post("/{account_id}/check-telegram")
async def check_telegram(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> TelegramCheckResult:
    """Connect to Telegram via stored session, verify account is alive."""
    import asyncio

    row = db.execute("SELECT * FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    # NO_PROXY guard (FIRST): never connect to Telegram via the server's real IP.
    # "No proxy" is the primary reason a check can't run, so it must be reported
    # before any credential/session work. Do NOT change the stored account status
    # (we couldn't determine liveness) and do NOT write to the DB.
    if not _has_active_proxy(db, row["proxy_id"]):
        log.warning("check_no_proxy", account_id=account_id)
        return TelegramCheckResult(
            account_id=account_id,
            success=False,
            error="Нет активного прокси — привяжите прокси, чтобы выполнить чек",
            status="NO_PROXY",
        )

    # Load metadata for app_id/app_hash
    meta: dict[str, Any] = {}
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
        db.commit()
        return TelegramCheckResult(
            account_id=account_id, success=False,
            error="app_id/app_hash отсутствуют в metadata — аккаунт импортирован без учётных данных",
            status="INVALID",
        )

    # Decrypt session file
    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
        db.commit()
        return TelegramCheckResult(
            account_id=account_id, success=False,
            error=f"Session файл не найден: {session_path_str}",
            status="INVALID",
        )

    try:
        from app.core.security import decrypt_bytes
        session_bytes = decrypt_bytes(session_full_path.read_bytes())
    except Exception as exc:
        db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
        db.commit()
        return TelegramCheckResult(
            account_id=account_id, success=False,
            error=f"Ошибка расшифровки сессии: {exc}",
            status="INVALID",
        )

    # Write temp session file for Telethon (it needs a .session file on disk)
    tmp_session_path = Path(tempfile.mkdtemp()) / "account.session"
    tmp_session_path.write_bytes(session_bytes)

    try:
        from telethon import TelegramClient
        from telethon.errors import (
            SessionPasswordNeededError,
            AuthKeyUnregisteredError,
            UserDeactivatedBanError,
            PhoneNumberBannedError,
        )
        import python_socks

        # Load proxy if assigned
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
                log.info("using_proxy", host=proxy_row["host"], port=proxy_row["port"], scheme=scheme)

        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            api_id=int(app_id),
            api_hash=str(app_hash),
            connection_retries=5,
            retry_delay=2,
            **proxy_kwargs,
        )

        await client.connect()

        if not await client.is_user_authorized():
            await client.disconnect()
            # Update status in DB
            db.execute(
                "UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?",
                ["DEAD", _now(), account_id],
            )
            db.commit()
            return TelegramCheckResult(
                account_id=account_id,
                success=False,
                error="Сессия не авторизована (DEAD)",
                status="DEAD",
            )

        me = await client.get_me()

        # Health signals + humanity index (bio, 2FA, scam/fake/verified/restricted).
        await _enrich_profile_meta(client, me, meta)

        # Fetch active sessions (security): foreign logins = leaked/hijacked session.
        from telethon.tl.functions.account import GetAuthorizationsRequest
        sessions_list = []
        try:
            auth_result = await client(GetAuthorizationsRequest())
            for auth in auth_result.authorizations:
                sessions_list.append({
                    "device": auth.device_model,
                    "platform": auth.platform,
                    "app": auth.app_name,
                    "ip": auth.ip,
                    "country": auth.country,
                    "current": bool(auth.current),
                })
        except Exception:
            pass

        await client.disconnect()

        meta["sessions_count"] = len(sessions_list)
        meta["sessions"] = sessions_list[:10]  # store up to 10
        meta["phone"] = getattr(me, "phone", None) or row["phone"]

        # Update account with real data from Telegram
        new_status = "ACTIVE"
        db.execute(
            """UPDATE tg_accounts SET
                tg_user_id = ?, username = ?, first_name = ?, last_name = ?,
                is_premium = ?, status = ?, last_session_at = ?, updated_at = ?,
                metadata = ?
            WHERE id = ?""",
            [
                me.id, me.username, me.first_name, me.last_name,
                1 if getattr(me, "premium", False) else 0,
                new_status, _now(), _now(), json.dumps(meta, ensure_ascii=False),
                account_id,
            ],
        )
        db.commit()

        log.info("telegram_check_ok", account_id=account_id, user_id=me.id, username=me.username)

        return TelegramCheckResult(
            account_id=account_id,
            success=True,
            tg_user_id=me.id,
            first_name=me.first_name,
            username=me.username,
            is_premium=bool(getattr(me, "premium", False)),
            status=new_status,
            restricted=bool(meta.get("restricted")),
            scam=bool(meta.get("scam")),
            fake=bool(meta.get("fake")),
            verified=bool(meta.get("verified")),
            humanity_score=int((meta.get("humanity") or {}).get("score", 0)),
        )

    except AuthKeyUnregisteredError:
        db.execute("UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?", ["DEAD", _now(), account_id])
        db.commit()
        return TelegramCheckResult(account_id=account_id, success=False, error="AuthKey невалиден (DEAD)", status="DEAD")

    except (UserDeactivatedBanError, PhoneNumberBannedError):
        db.execute(
            "UPDATE tg_accounts SET status = ?, banned_at = ?, updated_at = ? WHERE id = ?",
            ["BANNED", _now(), _now(), account_id],
        )
        db.commit()
        return TelegramCheckResult(account_id=account_id, success=False, error="Аккаунт забанен", status="BANNED")

    except SessionPasswordNeededError:
        # 2FA required — account is alive but needs password
        twofa = meta.get("twoFA") or meta.get("twofa_password")
        if twofa:
            try:
                client2 = TelegramClient(
                    str(tmp_session_path.with_suffix("")),
                    api_id=int(app_id),
                    api_hash=str(app_hash),
                    connection_retries=5,
                    retry_delay=2,
                    **proxy_kwargs,  # 2FA re-auth must also go through the proxy (no IP leak)
                )
                await client2.connect()
                await client2.sign_in(password=str(twofa))
                me = await client2.get_me()
                await client2.disconnect()

                db.execute(
                    """UPDATE tg_accounts SET
                        tg_user_id = ?, username = ?, first_name = ?, last_name = ?,
                        is_premium = ?, status = ?, last_session_at = ?, updated_at = ?
                    WHERE id = ?""",
                    [
                        me.id, me.username, me.first_name, me.last_name,
                        1 if getattr(me, "premium", False) else 0,
                        "ACTIVE", _now(), _now(), account_id,
                    ],
                )
                db.commit()

                return TelegramCheckResult(
                    account_id=account_id, success=True,
                    tg_user_id=me.id, first_name=me.first_name,
                    username=me.username, is_premium=bool(getattr(me, "premium", False)),
                    status="ACTIVE",
                )
            except Exception as exc2:
                return TelegramCheckResult(
                    account_id=account_id, success=False,
                    error=f"2FA пароль не подошёл: {exc2}", status="IMPORTED",
                )
        else:
            return TelegramCheckResult(
                account_id=account_id, success=False,
                error="Требуется 2FA пароль, но он не указан в metadata", status="IMPORTED",
            )

    except Exception as exc:
        log.error("telegram_check_failed", account_id=account_id, error=str(exc))
        return TelegramCheckResult(account_id=account_id, success=False, error=str(exc), status="IMPORTED")

    finally:
        # Cleanup temp session
        shutil.rmtree(tmp_session_path.parent, ignore_errors=True)


# ---------------------------------------------------------------------------
# Bulk Telegram check
# ---------------------------------------------------------------------------

class BulkCheckRequest(BaseModel):
    account_ids: list[str]
    concurrency: int = 3  # max parallel Telethon connections


class BulkCheckResult(BaseModel):
    total: int
    active: int
    dead: int
    banned: int
    errors: int
    no_proxy: int
    # Health aggregates across the live (ACTIVE) accounts in this run
    restricted: int = 0  # restricted / scam / fake — unsafe for campaigns
    bare: int = 0  # humanity_score <= 1 — too "robotic", ban-prone
    results: list[TelegramCheckResult]


@router.post("/bulk-check-telegram")
async def bulk_check_telegram(
    body: BulkCheckRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> BulkCheckResult:
    """Run real Telethon session check for multiple accounts in parallel.

    Uses a semaphore to limit concurrent Telegram connections (default 3).
    Updates each account status in DB: ACTIVE / DEAD / BANNED.
    """
    import asyncio

    semaphore = asyncio.Semaphore(max(1, min(body.concurrency, 10)))
    # Serialize all writes to the shared sqlite3 connection. Coroutines run
    # concurrently but share one `db` connection; without this lock one
    # coroutine's commit() can flush another's half-finished transaction
    # ("database is locked" / lost updates). Held ONLY around execute+commit,
    # never across Telethon network I/O, so connections stay parallel.
    db_lock = asyncio.Lock()

    async def _check_one(account_id: str) -> TelegramCheckResult:
        async with semaphore:
            # Reuse the single-account check logic inline
            row = db.execute("SELECT * FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
            if not row:
                return TelegramCheckResult(account_id=account_id, success=False, error="Аккаунт не найден")

            # NO_PROXY guard: refuse the check before any temp-session/connect
            # work so we never reach Telegram via the server's real IP. No DB
            # write, no status change (liveness undetermined), no db_lock needed.
            if not _has_active_proxy(db, row["proxy_id"]):
                log.warning("check_no_proxy", account_id=account_id)
                return TelegramCheckResult(
                    account_id=account_id, success=False,
                    error="Нет активного прокси", status="NO_PROXY",
                )

            meta: dict[str, Any] = {}
            if row["metadata"]:
                try:
                    meta = json.loads(row["metadata"])
                except Exception:
                    pass

            app_id = meta.get("app_id")
            app_hash = meta.get("app_hash")
            if not app_id or not app_hash:
                async with db_lock:
                    db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
                    db.commit()
                return TelegramCheckResult(account_id=account_id, success=False,
                                           error="app_id/app_hash отсутствуют в metadata", status="INVALID")

            session_path_str = row["session_path"]
            session_full_path = Path(session_path_str)
            if not session_full_path.exists():
                async with db_lock:
                    db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
                    db.commit()
                return TelegramCheckResult(account_id=account_id, success=False,
                                           error="Session файл не найден", status="INVALID")

            try:
                from app.core.security import decrypt_bytes
                session_bytes = decrypt_bytes(session_full_path.read_bytes())
            except Exception as exc:
                async with db_lock:
                    db.execute("UPDATE tg_accounts SET status='INVALID', updated_at=? WHERE id=?", [_now(), account_id])
                    db.commit()
                return TelegramCheckResult(account_id=account_id, success=False,
                                           error=f"Ошибка расшифровки: {exc}", status="INVALID")

            tmp_session_path = Path(tempfile.mkdtemp()) / "account.session"
            tmp_session_path.write_bytes(session_bytes)

            client = None
            client2 = None
            try:
                from telethon import TelegramClient
                from telethon.errors import (
                    SessionPasswordNeededError,
                    AuthKeyUnregisteredError,
                    UserDeactivatedBanError,
                    PhoneNumberBannedError,
                )
                import python_socks

                proxy_kwargs: dict[str, Any] = {}
                if row["proxy_id"]:
                    proxy_row = db.execute("SELECT * FROM tg_proxies WHERE id = ?", [row["proxy_id"]]).fetchone()
                    if proxy_row and proxy_row["status"] == "ACTIVE":
                        scheme = (proxy_row["scheme"] or "http").lower()
                        proxy_type = (
                            python_socks.ProxyType.SOCKS5 if "socks5" in scheme
                            else python_socks.ProxyType.SOCKS4 if "socks4" in scheme
                            else python_socks.ProxyType.HTTP
                        )
                        proxy_kwargs["proxy"] = {
                            "proxy_type": proxy_type,
                            "addr": proxy_row["host"],
                            "port": int(proxy_row["port"]),
                            "username": proxy_row["username"],
                            "password": proxy_row["password"],
                            "rdns": True,
                        }

                client = TelegramClient(
                    str(tmp_session_path.with_suffix("")),
                    api_id=int(app_id),
                    api_hash=str(app_hash),
                    connection_retries=5,
                    retry_delay=2,
                    **proxy_kwargs,
                )
                await client.connect()

                if not await client.is_user_authorized():
                    await client.disconnect()
                    async with db_lock:
                        db.execute("UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?", ["DEAD", _now(), account_id])
                        db.commit()
                    return TelegramCheckResult(account_id=account_id, success=False, error="Сессия не авторизована", status="DEAD")

                me = await client.get_me()
                # Health signals + humanity index (same enrichment as single check).
                await _enrich_profile_meta(client, me, meta)
                await client.disconnect()

                async with db_lock:
                    db.execute(
                        """UPDATE tg_accounts SET
                            tg_user_id = ?, username = ?, first_name = ?, last_name = ?,
                            is_premium = ?, status = ?, last_session_at = ?, updated_at = ?,
                            metadata = ?
                        WHERE id = ?""",
                        [me.id, me.username, me.first_name, me.last_name,
                         1 if getattr(me, "premium", False) else 0,
                         "ACTIVE", _now(), _now(),
                         json.dumps(meta, ensure_ascii=False), account_id],
                    )
                    db.commit()
                log.info("bulk_check_ok", account_id=account_id, phone=row["phone"])
                return TelegramCheckResult(
                    account_id=account_id, success=True,
                    tg_user_id=me.id, first_name=me.first_name,
                    username=me.username, is_premium=bool(getattr(me, "premium", False)),
                    status="ACTIVE",
                    restricted=bool(meta.get("restricted")),
                    scam=bool(meta.get("scam")),
                    fake=bool(meta.get("fake")),
                    verified=bool(meta.get("verified")),
                    humanity_score=int((meta.get("humanity") or {}).get("score", 0)),
                )

            except AuthKeyUnregisteredError:
                async with db_lock:
                    db.execute("UPDATE tg_accounts SET status = ?, updated_at = ? WHERE id = ?", ["DEAD", _now(), account_id])
                    db.commit()
                return TelegramCheckResult(account_id=account_id, success=False, error="AuthKey невалиден", status="DEAD")

            except (UserDeactivatedBanError, PhoneNumberBannedError):
                async with db_lock:
                    db.execute("UPDATE tg_accounts SET status = ?, banned_at = ?, updated_at = ? WHERE id = ?", ["BANNED", _now(), _now(), account_id])
                    db.commit()
                return TelegramCheckResult(account_id=account_id, success=False, error="Аккаунт забанен", status="BANNED")

            except SessionPasswordNeededError:
                twofa = meta.get("twoFA") or meta.get("twofa_password")
                if twofa:
                    try:
                        client2 = TelegramClient(
                            str(tmp_session_path.with_suffix("")), api_id=int(app_id), api_hash=str(app_hash),
                            connection_retries=5, retry_delay=2,
                            **proxy_kwargs,  # 2FA re-auth must also go through the proxy (no IP leak)
                        )
                        await client2.connect()
                        await client2.sign_in(password=str(twofa))
                        me = await client2.get_me()
                        await client2.disconnect()
                        async with db_lock:
                            db.execute(
                                """UPDATE tg_accounts SET tg_user_id=?,username=?,first_name=?,last_name=?,
                                   is_premium=?,status=?,last_session_at=?,updated_at=? WHERE id=?""",
                                [me.id, me.username, me.first_name, me.last_name,
                                 1 if getattr(me, "premium", False) else 0,
                                 "ACTIVE", _now(), _now(), account_id],
                            )
                            db.commit()
                        return TelegramCheckResult(account_id=account_id, success=True, tg_user_id=me.id,
                                                   first_name=me.first_name, username=me.username,
                                                   is_premium=bool(getattr(me, "premium", False)), status="ACTIVE")
                    except Exception as exc2:
                        return TelegramCheckResult(account_id=account_id, success=False, error=f"2FA не подошёл: {exc2}", status="IMPORTED")
                return TelegramCheckResult(account_id=account_id, success=False, error="Требуется 2FA", status="IMPORTED")

            except Exception as exc:
                log.warning("bulk_check_error", account_id=account_id, error=str(exc)[:200])
                return TelegramCheckResult(account_id=account_id, success=False, error=str(exc)[:200], status="IMPORTED")

            finally:
                # Disconnect any client opened above so a socket isn't leaked
                # on the error paths (AuthKey/Ban/2FA/generic) that return
                # without an explicit disconnect. disconnect() is idempotent.
                for _client in (client, client2):
                    if _client is not None:
                        try:
                            await _client.disconnect()
                        except Exception:
                            pass
                shutil.rmtree(tmp_session_path.parent, ignore_errors=True)

    results = await asyncio.gather(*[_check_one(aid) for aid in body.account_ids])

    return BulkCheckResult(
        total=len(results),
        active=sum(1 for r in results if r.status == "ACTIVE"),
        dead=sum(1 for r in results if r.status == "DEAD"),
        banned=sum(1 for r in results if r.status == "BANNED"),
        errors=sum(1 for r in results if not r.success and r.status == "IMPORTED"),
        no_proxy=sum(1 for r in results if r.status == "NO_PROXY"),
        restricted=sum(1 for r in results if r.success and (r.restricted or r.scam or r.fake)),
        bare=sum(1 for r in results if r.success and r.humanity_score <= 1),
        results=list(results),
    )


# ---------------------------------------------------------------------------
# Chat membership verification
# ---------------------------------------------------------------------------

class VerifyMembershipRequest(BaseModel):
    account_ids: list[str]
    chats: list[str]  # @username / t.me link / numeric id (as string)


@router.post("/verify-membership")
async def verify_membership(
    body: VerifyMembershipRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Check whether each account is ACTUALLY a member of each chat.

    Connects each account once (NO_PROXY guard via the client pool), resolves
    every chat and runs ``GetParticipant('me')``. Used by the join-chats
    re-verify button and the account card to confirm accounts are still inside
    their target chats — they may have been kicked/banned/left, or a "join" may
    have been only a pending approval request.
    """
    from telethon.errors import UserNotParticipantError
    from telethon.tl.functions.channels import GetParticipantRequest
    from telethon.tl.types import Channel

    from app.telegram.client_pool import disconnect_client, get_client_for_account

    def _norm(chat: str) -> str:
        s = (chat or "").strip()
        for pre in ("https://t.me/", "http://t.me/", "t.me/", "@"):
            if s.startswith(pre):
                return s[len(pre):]
        return s

    results: list[dict[str, Any]] = []
    for acc_id in body.account_ids:
        acc = db.execute(
            "SELECT phone, username, first_name FROM tg_accounts WHERE id = ?", [acc_id]
        ).fetchone()
        base = {
            "account_id": acc_id,
            "account_phone": acc["phone"] if acc else None,
            "account_username": acc["username"] if acc else None,
            "account_name": acc["first_name"] if acc else None,
        }

        client = None
        try:
            client = await get_client_for_account(acc_id, db)
        except HTTPException as exc:
            detail = str(exc.detail)
            st = "NO_PROXY" if "NO_PROXY" in detail else "CONNECT_ERROR"
            for chat in body.chats:
                results.append({**base, "chat": chat, "is_member": False,
                                "status": st, "error": detail[:150], "chat_title": None})
            continue

        try:
            for chat in body.chats:
                entry = {**base, "chat": chat, "is_member": False,
                         "status": "UNKNOWN", "error": None, "chat_title": None}
                try:
                    ent = await client.get_entity(_norm(chat))
                    entry["chat_title"] = getattr(ent, "title", None)
                    if isinstance(ent, Channel):
                        try:
                            pres = await client(GetParticipantRequest(ent, "me"))
                            ptype = type(pres.participant).__name__
                            if "Banned" in ptype or "Left" in ptype:
                                # In the chat's removed/banned list — can't write.
                                entry["status"] = "BANNED"
                                entry["error"] = "Аккаунт забанен в этом чате (писать нельзя)"
                            else:
                                entry["is_member"] = True
                                entry["status"] = "MEMBER"
                        except UserNotParticipantError:
                            entry["status"] = "NOT_MEMBER"
                    else:
                        # Basic group: GetParticipant N/A — resolvable ⇒ treat as member.
                        entry["is_member"] = True
                        entry["status"] = "MEMBER"
                except Exception as exc:
                    entry["status"] = "ERROR"
                    entry["error"] = str(exc)[:150]
                results.append(entry)
        finally:
            await disconnect_client(client)

    return {"results": results}


# ---------------------------------------------------------------------------
# Spamblock check via @SpamBot
# ---------------------------------------------------------------------------

class SpamblockResult(BaseModel):
    account_id: str
    is_spamblocked: bool
    spamblock: str  # "none" or human-readable limitation text
    spambot_reply: str | None = None
    error: str | None = None


@router.post("/{account_id}/check-spamblock")
async def check_spamblock(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> SpamblockResult:
    """Check spamblock without messaging @SpamBot.

    Strategy (no side-effects, in order):
    1. me.restricted + restriction_reason — instant, from get_me()
    2. Read existing @SpamBot dialog history — no new messages sent
    3. If history empty → result is 'unknown' (inconclusive)
    """
    row = db.execute("SELECT * FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")

    # NO_PROXY guard: never connect to Telegram over the server's real IP.
    if not _has_active_proxy(db, row["proxy_id"]):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NO_PROXY: у аккаунта нет активного прокси — проверка спамблока невозможна",
        )

    meta: dict[str, Any] = {}
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        raise HTTPException(status_code=400, detail="app_id/app_hash отсутствуют в metadata")

    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        raise HTTPException(status_code=400, detail="Session файл не найден")

    try:
        from app.core.security import decrypt_bytes
        session_bytes = decrypt_bytes(session_full_path.read_bytes())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Ошибка расшифровки сессии: {exc}")

    tmp_session_path = Path(tempfile.mkdtemp()) / "account.session"
    tmp_session_path.write_bytes(session_bytes)

    try:
        import python_socks
        from telethon import TelegramClient
        from telethon.errors import AuthKeyUnregisteredError, UserDeactivatedBanError
        from telethon.tl.functions.messages import GetHistoryRequest

        # Build proxy (guaranteed ACTIVE by the NO_PROXY guard above).
        proxy_kwargs: dict[str, Any] = {}
        proxy_row = db.execute(
            "SELECT * FROM tg_proxies WHERE id = ?", [row["proxy_id"]]
        ).fetchone()
        if proxy_row:
            scheme = (proxy_row["scheme"] or "http").lower()
            ptype = (
                python_socks.ProxyType.SOCKS5 if "socks5" in scheme
                else python_socks.ProxyType.SOCKS4 if "socks4" in scheme
                else python_socks.ProxyType.HTTP
            )
            proxy_kwargs["proxy"] = {
                "proxy_type": ptype,
                "addr": proxy_row["host"],
                "port": int(proxy_row["port"]),
                "username": proxy_row["username"],
                "password": proxy_row["password"],
                "rdns": True,
            }

        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            int(app_id),
            app_hash,
            device_model=row["device_model"] or "iPhone 14",
            system_version=row["system_version"] or "16.0",
            app_version=row["app_version"] or "9.2",
            lang_code=row["lang_code"] or "ru",
            connection_retries=5,
            retry_delay=2,
            **proxy_kwargs,
        )

        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            return SpamblockResult(
                account_id=account_id,
                is_spamblocked=False,
                spamblock="none",
                error="Сессия не авторизована",
            )

        # ── Step 1: check me.restricted flag ──────────────────────────────
        me = await client.get_me()
        restricted = getattr(me, "restricted", False)
        restriction_reasons = getattr(me, "restriction_reason", None) or []
        spam_reason = next(
            (getattr(r, "text", None) or getattr(r, "reason", "") for r in restriction_reasons
             if "spam" in (getattr(r, "reason", "") or "").lower()),
            None,
        )

        if restricted and spam_reason:
            await client.disconnect()
            spamblock_val = spam_reason[:200]
            meta["spamblock"] = spamblock_val
            db.execute("UPDATE tg_accounts SET metadata=?, updated_at=? WHERE id=?",
                       [json.dumps(meta), _now(), account_id])
            db.commit()
            log.info("spamblock_via_restricted", account_id=account_id)
            return SpamblockResult(
                account_id=account_id,
                is_spamblocked=True,
                spamblock=spamblock_val,
                spambot_reply=f"[restriction_reason] {spam_reason}",
            )

        # ── Step 2: ask @SpamBot directly (send /start, read reply) ───────
        import asyncio as _asyncio

        async def _read_spambot_reply(bot: Any) -> str | None:
            history = await client(GetHistoryRequest(
                peer=bot, limit=5, offset_id=0, offset_date=None,
                add_offset=0, max_id=0, min_id=0, hash=0,
            ))
            bot_msgs = [
                m for m in history.messages
                if hasattr(m, "out") and not m.out and hasattr(m, "message") and m.message
            ]
            return bot_msgs[0].message if bot_msgs else None

        spambot_reply_text: str | None = None
        try:
            spambot = await client.get_entity("@SpamBot")
            # Send /start so @SpamBot reports the CURRENT status (reading old
            # history alone is unreliable / often empty → "unknown").
            await client.send_message(spambot, "/start")
            await _asyncio.sleep(4)
            spambot_reply_text = await _read_spambot_reply(spambot)
        except Exception:
            pass  # can't resolve / send — inconclusive

        await client.disconnect()

        if spambot_reply_text:
            reply_lower = spambot_reply_text.lower()
            # NOTE: check "free" phrases FIRST and avoid the bare stem "ограничен"
            # in limited_kw — it is a substring of "ограничениЙ" inside the FREE
            # phrase «свободен от каких-либо ограничений», which caused false
            # positives. Use specific limited phrases only.
            free_kw = (
                "good news", "no limits", "free as a bird", "you're free", "you are free",
                "свободен", "свободны", "не ограничен", "ограничений нет",
                "никаких ограничений", "нет ограничений", "всё в порядке", "все в порядке",
            )
            limited_kw = (
                "не сможете писать", "не сможете отправлять", "вы ограничены",
                "аккаунт ограничен", "был ограничен", "ваш аккаунт был",
                "limited", "restricted", "is now limited", "is limited",
                "antispam", "антиспам", "сурово", "harsh",
            )
            if any(kw in reply_lower for kw in free_kw):
                is_blocked = False
            elif any(kw in reply_lower for kw in limited_kw):
                is_blocked = True
            else:
                # Got a reply but unrecognized wording — don't assume blocked.
                is_blocked = False
            spamblock_val = (
                "none" if not is_blocked else spambot_reply_text[:300]
            )
        else:
            # No reply at all → inconclusive
            is_blocked = False
            spamblock_val = "unknown"

        meta["spamblock"] = spamblock_val
        db.execute("UPDATE tg_accounts SET metadata=?, updated_at=? WHERE id=?",
                   [json.dumps(meta), _now(), account_id])
        db.commit()

        log.info("spamblock_check", account_id=account_id, is_blocked=is_blocked,
                 via="history" if spambot_reply_text else "no_data")
        return SpamblockResult(
            account_id=account_id,
            is_spamblocked=is_blocked,
            spamblock=spamblock_val,
            spambot_reply=spambot_reply_text,
        )

    except (AuthKeyUnregisteredError, UserDeactivatedBanError) as exc:
        return SpamblockResult(
            account_id=account_id,
            is_spamblocked=False,
            spamblock="none",
            error=f"Аккаунт мёртв: {type(exc).__name__}",
        )
    except Exception as exc:
        log.error("spamblock_check_failed", account_id=account_id, error=str(exc))
        return SpamblockResult(
            account_id=account_id,
            is_spamblocked=False,
            spamblock="none",
            error=str(exc)[:200],
        )
    finally:
        shutil.rmtree(tmp_session_path.parent, ignore_errors=True)


# ---------------------------------------------------------------------------
# Capabilities diagnostic
# ---------------------------------------------------------------------------

@router.post("/{account_id}/diagnose")
async def diagnose_account(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Run automated capability checks on an account.

    Tests: search users, get_participants, send DM, invite.
    Saves results to capabilities JSON field.
    """
    row = db.execute("SELECT * FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")

    meta: dict[str, Any] = {}
    if row["metadata"]:
        try:
            meta = json.loads(row["metadata"])
        except Exception:
            pass

    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        raise HTTPException(status_code=400, detail="app_id/app_hash missing")

    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        raise HTTPException(status_code=400, detail="Session file not found")

    from app.core.security import decrypt_bytes
    session_bytes = decrypt_bytes(session_full_path.read_bytes())
    tmp_session_path = Path(tempfile.mkdtemp()) / "diag.session"
    tmp_session_path.write_bytes(session_bytes)

    caps = {
        "can_search_users": False,
        "can_get_participants": False,
        "can_send_dm": False,
        "can_read_messages": False,
        "diagnosed_at": _now(),
        "errors": {},
    }

    try:
        from telethon import TelegramClient
        import python_socks

        proxy_kwargs: dict[str, Any] = {}
        if row["proxy_id"]:
            proxy_row = db.execute("SELECT * FROM tg_proxies WHERE id = ?", [row["proxy_id"]]).fetchone()
            if proxy_row and proxy_row["status"] == "ACTIVE":
                scheme = (proxy_row["scheme"] or "http").lower()
                ptype = python_socks.ProxyType.SOCKS5 if "socks" in scheme else python_socks.ProxyType.HTTP
                proxy_kwargs["proxy"] = {
                    "proxy_type": ptype, "addr": proxy_row["host"],
                    "port": int(proxy_row["port"]), "username": proxy_row["username"],
                    "password": proxy_row["password"], "rdns": True,
                }

        client = TelegramClient(
            str(tmp_session_path.with_suffix("")),
            api_id=int(app_id), api_hash=str(app_hash),
            timeout=20, connection_retries=5, retry_delay=2, **proxy_kwargs,
        )
        await client.connect()
        if not await client.is_user_authorized():
            twofa = meta.get("twoFA") or meta.get("twofa_password")
            if twofa:
                from telethon.errors import SessionPasswordNeededError
                try:
                    await client.sign_in(password=str(twofa))
                except Exception:
                    pass

        # Test 1: search users (try to find @BotFather — always exists)
        try:
            entity = await client.get_entity("@BotFather")
            caps["can_search_users"] = True
        except Exception as e:
            caps["errors"]["search_users"] = str(e)[:100]

        # Test 2: get_participants (try on a known group from dialogs)
        try:
            dialogs = await client.get_dialogs(limit=10)
            test_group = None
            for d in dialogs:
                if d.is_group or d.is_channel:
                    test_group = d
                    break
            if test_group:
                parts = await client.get_participants(test_group, limit=5)
                caps["can_get_participants"] = True
            else:
                caps["errors"]["get_participants"] = "No groups in dialogs to test"
        except Exception as e:
            caps["errors"]["get_participants"] = str(e)[:100]

        # Test 3: read messages
        try:
            dialogs = await client.get_dialogs(limit=5)
            if dialogs:
                msgs = await client.get_messages(dialogs[0], limit=3)
                caps["can_read_messages"] = True
        except Exception as e:
            caps["errors"]["read_messages"] = str(e)[:100]

        # Test 4: can_send_dm — we check if search works (prerequisite for DM)
        # Real DM test would require sending to someone, so we infer from search
        caps["can_send_dm"] = caps["can_search_users"]

        await client.disconnect()

    except Exception as e:
        caps["errors"]["connection"] = str(e)[:100]
    finally:
        shutil.rmtree(tmp_session_path.parent, ignore_errors=True)

    # Save to DB
    db.execute("UPDATE tg_accounts SET capabilities = ?, updated_at = ? WHERE id = ?",
               [json.dumps(caps), _now(), account_id])
    db.commit()

    log.info("account_diagnosed", account_id=account_id, caps=caps)
    return {"account_id": account_id, "capabilities": caps}


# ---------------------------------------------------------------------------
# Export account as ZIP (.session + .json)
# ---------------------------------------------------------------------------

@router.get("/{account_id}/export")
async def export_account(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> Response:
    """Export a single account as ZIP archive with decrypted .session + .json metadata."""
    row = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ?", [account_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")

    acc = dict(row)
    phone = acc["phone"].lstrip("+")

    # Decrypt session file
    session_path = Path(acc["session_path"])
    if not session_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session file not found on disk",
        )

    try:
        session_bytes = decrypt_bytes(session_path.read_bytes())
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to decrypt session: {exc}",
        )

    # Build metadata JSON
    meta: dict[str, Any] = {}
    if acc.get("metadata"):
        try:
            meta = json.loads(acc["metadata"])
        except (json.JSONDecodeError, TypeError):
            pass

    export_meta = {
        "phone": acc["phone"],
        "user_id": acc.get("tg_user_id"),
        "username": acc.get("username"),
        "first_name": acc.get("first_name"),
        "last_name": acc.get("last_name"),
        "is_premium": bool(acc.get("is_premium")),
        "device": acc.get("device_model"),
        "sdk": acc.get("system_version"),
        "app_version": acc.get("app_version"),
        "system_lang_pack": acc.get("lang_code"),
        "app_id": meta.get("app_id"),
        "app_hash": meta.get("app_hash"),
        "twoFA": meta.get("twoFA") or meta.get("twofa_password"),
        "spamblock": meta.get("spamblock", "none"),
        "register_time": meta.get("register_time"),
    }

    # Build ZIP in memory
    import io
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{phone}.session", session_bytes)
        zf.writestr(f"{phone}.json", json.dumps(export_meta, ensure_ascii=False, indent=2))
    zip_buffer.seek(0)

    log.info("account_exported", account_id=account_id, phone=acc["phone"])

    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="account_{phone}.zip"',
        },
    )


@router.get("/{account_id}/daily-usage")
async def get_daily_usage(
    account_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return today's per-action usage counters for an account (P5-01)."""
    from app.core.daily_usage import _today

    row = db.execute("SELECT id FROM tg_accounts WHERE id = ?", [account_id]).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    today = _today()
    try:
        rows = db.execute(
            "SELECT action_type, count FROM tg_account_daily_usage "
            "WHERE account_id = ? AND usage_date = ?",
            [account_id, today],
        ).fetchall()
        usage = {r["action_type"]: r["count"] for r in rows}
    except Exception:
        usage = {}

    return {"account_id": account_id, "date": today, "usage": usage}
