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

from app.config import settings
from app.core.security import encrypt_bytes
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

    return data


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
                db.execute(
                    "UPDATE tg_accounts SET last_session_at = ?, updated_at = ? WHERE id = ?",
                    [now, now, account_id],
                )
                success += 1

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

                account_id = str(uuid.uuid4())
                db.execute(
                    """
                    INSERT INTO tg_accounts
                        (id, phone, tg_user_id, username, first_name, last_name,
                         session_path, device_model, system_version, app_version,
                         lang_code, is_premium, status,
                         tags, metadata, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        account_id, phone, tg_user_id, username, first_name, last_name,
                        rel_session_path, device_model, system_version, app_version,
                        lang_code, is_premium, initial_status,
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
        raise HTTPException(status_code=400, detail="app_id/app_hash отсутствуют в metadata аккаунта")

    # Decrypt session file
    session_path_str = row["session_path"]
    session_full_path = Path(session_path_str)
    if not session_full_path.exists():
        raise HTTPException(status_code=400, detail=f"Session файл не найден: {session_path_str}")

    try:
        from app.core.security import decrypt_bytes
        session_bytes = decrypt_bytes(session_full_path.read_bytes())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Ошибка расшифровки сессии: {exc}")

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
        await client.disconnect()

        # Update account with real data from Telegram
        new_status = "ACTIVE"
        db.execute(
            """UPDATE tg_accounts SET
                tg_user_id = ?, username = ?, first_name = ?, last_name = ?,
                is_premium = ?, status = ?, last_session_at = ?, updated_at = ?
            WHERE id = ?""",
            [
                me.id, me.username, me.first_name, me.last_name,
                1 if getattr(me, "premium", False) else 0,
                new_status, _now(), _now(), account_id,
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
