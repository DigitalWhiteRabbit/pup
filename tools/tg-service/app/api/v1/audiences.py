"""CRUD + merge/export endpoints for Telegram audience databases."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/audiences", tags=["audiences"])

log = structlog.get_logger(__name__)

VALID_SOURCE_TYPES = {"PARSED", "IMPORTED", "MERGED", "FILTERED"}
VALID_AI_CATEGORIES = {"HIGH", "MEDIUM", "LOW", "IRRELEVANT"}
VALID_MERGE_OPS = {"UNION", "SUBTRACT", "INTERSECT"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class AudienceCreate(BaseModel):
    name: str
    description: str | None = None
    source_type: str = "IMPORTED"
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] | None = None


class MergeRequest(BaseModel):
    source_ids: list[str]
    operation: str  # UNION|SUBTRACT|INTERSECT
    name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_audience(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
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


def _row_to_member(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict for an audience member."""
    data = dict(row)
    if data.get("metadata"):
        try:
            data["metadata"] = json.loads(data["metadata"])
        except (json.JSONDecodeError, TypeError):
            data["metadata"] = None
    else:
        data["metadata"] = None
    return data


# ---------------------------------------------------------------------------
# Routes — Audiences CRUD
# ---------------------------------------------------------------------------

@router.get("")
async def list_audiences(
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List all audiences with pagination."""
    count_row = db.execute(
        "SELECT COUNT(*) AS total FROM tg_audiences"
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        "SELECT * FROM tg_audiences ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [limit, offset],
    ).fetchall()

    items = [_row_to_audience(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{audience_id}")
async def get_audience(
    audience_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single audience with live member count."""
    row = db.execute(
        "SELECT * FROM tg_audiences WHERE id = ?", [audience_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Audience not found")

    data = _row_to_audience(row)

    # Live member counts
    count_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_audience_members WHERE audience_id = ?",
        [audience_id],
    ).fetchone()
    data["member_count"] = count_row["cnt"] if count_row else 0

    return data


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_audience(
    body: AudienceCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create an empty audience."""
    if body.source_type not in VALID_SOURCE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid source_type '{body.source_type}'. Must be one of: {', '.join(sorted(VALID_SOURCE_TYPES))}",
        )

    now = _now()
    audience_id = str(uuid.uuid4())
    tags_json = json.dumps(body.tags or [])
    metadata_json = json.dumps(body.metadata) if body.metadata else None

    try:
        db.execute(
            """INSERT INTO tg_audiences
                (id, name, description, source_type, tags, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [audience_id, body.name, body.description, body.source_type,
             tags_json, metadata_json, now, now],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_audiences WHERE id = ?", [audience_id]
    ).fetchone()

    log.info("audience_created", audience_id=audience_id, name=body.name)
    return _row_to_audience(row)


@router.delete("/{audience_id}")
async def delete_audience(
    audience_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete an audience and all its members (CASCADE)."""
    existing = db.execute(
        "SELECT id FROM tg_audiences WHERE id = ?", [audience_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Audience not found")

    try:
        db.execute("DELETE FROM tg_audiences WHERE id = ?", [audience_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("audience_deleted", audience_id=audience_id)
    return {"status": "deleted", "id": audience_id}


# ---------------------------------------------------------------------------
# Routes — Members
# ---------------------------------------------------------------------------

@router.get("/{audience_id}/members")
async def list_members(
    audience_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    is_premium: int | None = Query(None),
    has_username: int | None = Query(None),
    ai_category: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List audience members with filters and pagination."""
    # Verify audience exists
    existing = db.execute(
        "SELECT id FROM tg_audiences WHERE id = ?", [audience_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Audience not found")

    conditions: list[str] = ["audience_id = ?"]
    params: list[Any] = [audience_id]

    if is_premium is not None:
        conditions.append("is_premium = ?")
        params.append(is_premium)

    if has_username is not None:
        if has_username:
            conditions.append("username IS NOT NULL AND username != ''")
        else:
            conditions.append("(username IS NULL OR username = '')")

    if ai_category:
        if ai_category not in VALID_AI_CATEGORIES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid ai_category '{ai_category}'. Must be one of: {', '.join(sorted(VALID_AI_CATEGORIES))}",
            )
        conditions.append("ai_category = ?")
        params.append(ai_category)

    if search:
        conditions.append("(username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like, like, like])

    where = f"WHERE {' AND '.join(conditions)}"

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_audience_members {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_audience_members {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_member(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ---------------------------------------------------------------------------
# Routes — Merge
# ---------------------------------------------------------------------------

@router.post("/merge", status_code=status.HTTP_201_CREATED)
async def merge_audiences(
    body: MergeRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new audience from a set operation on existing audiences."""
    if body.operation not in VALID_MERGE_OPS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid operation '{body.operation}'. Must be one of: {', '.join(sorted(VALID_MERGE_OPS))}",
        )

    if len(body.source_ids) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least 2 source audience IDs are required for merge.",
        )

    # Verify all source audiences exist
    for src_id in body.source_ids:
        row = db.execute(
            "SELECT id FROM tg_audiences WHERE id = ?", [src_id]
        ).fetchone()
        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Source audience '{src_id}' not found",
            )

    now = _now()
    new_audience_id = str(uuid.uuid4())

    try:
        # Create the result audience
        db.execute(
            """INSERT INTO tg_audiences
                (id, name, source_type, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [new_audience_id, body.name, "MERGED",
             json.dumps({"source_ids": body.source_ids, "operation": body.operation}),
             now, now],
        )

        if body.operation == "UNION":
            # All unique members from all source audiences
            placeholders = ",".join("?" * len(body.source_ids))
            rows = db.execute(
                f"""SELECT DISTINCT tg_user_id, username, first_name, last_name,
                           phone, about, is_premium, is_bot, has_avatar,
                           source_chat, last_seen_at, country,
                           ai_score, ai_category, metadata
                    FROM tg_audience_members
                    WHERE audience_id IN ({placeholders}) AND tg_user_id IS NOT NULL
                    GROUP BY tg_user_id""",
                body.source_ids,
            ).fetchall()

        elif body.operation == "INTERSECT":
            # Members present in ALL source audiences
            first_id = body.source_ids[0]
            rest_ids = body.source_ids[1:]
            rest_placeholders = ",".join("?" * len(rest_ids))

            rows = db.execute(
                f"""SELECT m.tg_user_id, m.username, m.first_name, m.last_name,
                           m.phone, m.about, m.is_premium, m.is_bot, m.has_avatar,
                           m.source_chat, m.last_seen_at, m.country,
                           m.ai_score, m.ai_category, m.metadata
                    FROM tg_audience_members m
                    WHERE m.audience_id = ? AND m.tg_user_id IS NOT NULL
                      AND m.tg_user_id IN (
                          SELECT tg_user_id FROM tg_audience_members
                          WHERE audience_id IN ({rest_placeholders}) AND tg_user_id IS NOT NULL
                          GROUP BY tg_user_id
                          HAVING COUNT(DISTINCT audience_id) = ?
                      )""",
                [first_id, *rest_ids, len(rest_ids)],
            ).fetchall()

        elif body.operation == "SUBTRACT":
            # Members in first audience but NOT in any of the rest
            first_id = body.source_ids[0]
            rest_ids = body.source_ids[1:]
            rest_placeholders = ",".join("?" * len(rest_ids))

            rows = db.execute(
                f"""SELECT m.tg_user_id, m.username, m.first_name, m.last_name,
                           m.phone, m.about, m.is_premium, m.is_bot, m.has_avatar,
                           m.source_chat, m.last_seen_at, m.country,
                           m.ai_score, m.ai_category, m.metadata
                    FROM tg_audience_members m
                    WHERE m.audience_id = ? AND m.tg_user_id IS NOT NULL
                      AND m.tg_user_id NOT IN (
                          SELECT tg_user_id FROM tg_audience_members
                          WHERE audience_id IN ({rest_placeholders}) AND tg_user_id IS NOT NULL
                      )""",
                [first_id, *rest_ids],
            ).fetchall()
        else:
            rows = []

        # Insert deduplicated members into new audience
        inserted = 0
        for r in rows:
            member_id = str(uuid.uuid4())
            db.execute(
                """INSERT OR IGNORE INTO tg_audience_members
                    (id, audience_id, tg_user_id, username, first_name, last_name,
                     phone, about, is_premium, is_bot, has_avatar,
                     source_chat, last_seen_at, country,
                     ai_score, ai_category, metadata, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [member_id, new_audience_id,
                 r["tg_user_id"], r["username"], r["first_name"], r["last_name"],
                 r["phone"], r["about"], r["is_premium"], r["is_bot"], r["has_avatar"],
                 r["source_chat"], r["last_seen_at"], r["country"],
                 r["ai_score"], r["ai_category"], r["metadata"], now],
            )
            inserted += 1

        # Update counts on new audience
        db.execute(
            """UPDATE tg_audiences
               SET total_count = ?, unique_count = ?, updated_at = ?
               WHERE id = ?""",
            [inserted, inserted, now, new_audience_id],
        )

        db.commit()
    except HTTPException:
        raise
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_audiences WHERE id = ?", [new_audience_id]
    ).fetchone()
    data = _row_to_audience(row)
    data["member_count"] = inserted

    log.info(
        "audiences_merged",
        audience_id=new_audience_id,
        operation=body.operation,
        source_count=len(body.source_ids),
        result_count=inserted,
    )
    return data


# ---------------------------------------------------------------------------
# Routes — Export
# ---------------------------------------------------------------------------

@router.post("/{audience_id}/export")
async def export_audience(
    audience_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Export all members of an audience as a JSON array (for download)."""
    existing = db.execute(
        "SELECT id, name FROM tg_audiences WHERE id = ?", [audience_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Audience not found")

    rows = db.execute(
        """SELECT tg_user_id, username, first_name, last_name, phone, about,
                  is_premium, is_bot, has_avatar, source_chat, last_seen_at,
                  country, ai_score, ai_category
           FROM tg_audience_members
           WHERE audience_id = ?
           ORDER BY created_at DESC""",
        [audience_id],
    ).fetchall()

    members = [dict(r) for r in rows]

    log.info("audience_exported", audience_id=audience_id, count=len(members))
    return {
        "audience_id": audience_id,
        "audience_name": existing["name"],
        "count": len(members),
        "members": members,
    }
