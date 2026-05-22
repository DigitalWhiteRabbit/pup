"""Phone number checker — batch-check phones against Telegram."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/phone-checker", tags=["phone-checker"])

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PhoneCheckRequest(BaseModel):
    phones: list[str]
    account_id: str | None = None  # optional: use specific account for checking


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_batch(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict for a phone check batch."""
    return dict(row)


def _row_to_result(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict for a phone check result."""
    return dict(row)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_batches(
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List all phone check batches with pagination."""
    count_row = db.execute(
        "SELECT COUNT(*) AS total FROM tg_phone_checks"
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        "SELECT * FROM tg_phone_checks ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [limit, offset],
    ).fetchall()

    items = [_row_to_batch(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/check", status_code=status.HTTP_201_CREATED)
async def check_phones(
    body: PhoneCheckRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a phone check batch and start checking.

    Each phone is validated, normalized, and then checked against Telegram
    via Telethon (if available). Results are stored per-phone in the batch.
    """
    if not body.phones:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="phones list must not be empty",
        )

    if len(body.phones) > 10000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Maximum 10000 phones per batch",
        )

    now = _now()
    batch_id = str(uuid.uuid4())

    # Normalize phones
    normalized: list[str] = []
    for phone in body.phones:
        p = phone.strip()
        if not p:
            continue
        if not p.startswith("+"):
            p = "+" + p
        normalized.append(p)

    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid phone numbers provided",
        )

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique_phones: list[str] = []
    for p in normalized:
        if p not in seen:
            seen.add(p)
            unique_phones.append(p)

    # Create batch record
    try:
        db.execute(
            """INSERT INTO tg_phone_checks
                (id, status, input_count, started_at, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            [batch_id, "RUNNING", len(unique_phones), now, now],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Attempt Telethon-based checking
    found_count = 0
    premium_count = 0
    telethon_available = False

    try:
        from app.telegram.client_pool import get_client_for_account, get_any_client

        if body.account_id:
            client = await get_client_for_account(body.account_id, db)
        else:
            client = await get_any_client(db)

        telethon_available = True

        # Check phones in batches to avoid flood
        from telethon.tl.functions.contacts import ImportContactsRequest, DeleteContactsRequest
        from telethon.tl.types import InputPhoneContact

        for i, phone in enumerate(unique_phones):
            result_id = str(uuid.uuid4())
            try:
                # Import as contact to resolve
                contact = InputPhoneContact(
                    client_id=i,
                    phone=phone,
                    first_name="check",
                    last_name="",
                )
                result = await client(ImportContactsRequest([contact]))

                found = False
                tg_user_id = None
                username = None
                first_name = None
                is_premium = 0

                if result.users:
                    user = result.users[0]
                    found = True
                    tg_user_id = user.id
                    username = getattr(user, "username", None)
                    first_name = getattr(user, "first_name", None)
                    is_premium = 1 if getattr(user, "premium", False) else 0
                    found_count += 1
                    if is_premium:
                        premium_count += 1

                    # Clean up: delete imported contact
                    try:
                        await client(DeleteContactsRequest(id=[user]))
                    except Exception:
                        pass

                db.execute(
                    """INSERT INTO tg_phone_check_results
                        (id, batch_id, phone, found, tg_user_id, username, first_name, is_premium, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    [result_id, batch_id, phone, 1 if found else 0,
                     tg_user_id, username, first_name, is_premium, now],
                )

            except Exception as exc:
                log.warning("phone_check_error", phone=phone, error=str(exc))
                db.execute(
                    """INSERT INTO tg_phone_check_results
                        (id, batch_id, phone, found, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    [result_id, batch_id, phone, 0, now],
                )

        db.commit()

    except ImportError:
        log.warning("telethon_not_available_for_phone_check")
    except Exception as exc:
        log.error("phone_check_client_error", error=str(exc))

    # If Telethon is not available, create placeholder results
    if not telethon_available:
        for phone in unique_phones:
            result_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO tg_phone_check_results
                    (id, batch_id, phone, found, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                [result_id, batch_id, phone, 0, now],
            )
        try:
            db.commit()
        except Exception:
            db.rollback()
            raise

    # Update batch with final counts
    finished_at = _now()
    final_status = "COMPLETED" if telethon_available else "PENDING"
    try:
        db.execute(
            """UPDATE tg_phone_checks
               SET status = ?, found_count = ?, premium_count = ?, finished_at = ?
               WHERE id = ?""",
            [final_status, found_count, premium_count, finished_at, batch_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Return batch with results
    batch_row = db.execute(
        "SELECT * FROM tg_phone_checks WHERE id = ?", [batch_id]
    ).fetchone()

    result_rows = db.execute(
        "SELECT * FROM tg_phone_check_results WHERE batch_id = ? ORDER BY created_at",
        [batch_id],
    ).fetchall()

    batch_data = _row_to_batch(batch_row)
    batch_data["results"] = [_row_to_result(r) for r in result_rows]

    log.info(
        "phone_check_complete",
        batch_id=batch_id,
        input_count=len(unique_phones),
        found_count=found_count,
        premium_count=premium_count,
        telethon_available=telethon_available,
    )

    return batch_data


@router.get("/{batch_id}")
async def get_batch(
    batch_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a phone check batch with all results."""
    batch_row = db.execute(
        "SELECT * FROM tg_phone_checks WHERE id = ?", [batch_id]
    ).fetchone()
    if not batch_row:
        raise HTTPException(status_code=404, detail="Phone check batch not found")

    result_rows = db.execute(
        "SELECT * FROM tg_phone_check_results WHERE batch_id = ? ORDER BY created_at",
        [batch_id],
    ).fetchall()

    batch_data = _row_to_batch(batch_row)
    batch_data["results"] = [_row_to_result(r) for r in result_rows]

    return batch_data
