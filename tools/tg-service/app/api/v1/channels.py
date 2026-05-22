"""CRUD + resolve endpoints for Telegram channels database."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/channels", tags=["channels"])

log = structlog.get_logger(__name__)

VALID_TYPES = {"CHANNEL", "SUPERGROUP", "BASIC_GROUP", "FORUM"}
VALID_ROLES = {"SOURCE", "TARGET", "BOTH", "NONE"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ChannelCreate(BaseModel):
    username: str | None = None
    tg_id: int | None = None
    title: str
    about: str | None = None
    type: str = "CHANNEL"
    is_public: int = 1
    members_count: int = 0
    avg_messages_day: float | None = None
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    language: str | None = None
    role: str = "NONE"
    is_own: int = 0
    metadata: dict[str, Any] | None = None


class ChannelUpdate(BaseModel):
    username: str | None = None
    title: str | None = None
    about: str | None = None
    type: str | None = None
    is_public: int | None = None
    members_count: int | None = None
    avg_messages_day: float | None = None
    category: str | None = None
    tags: list[str] | None = None
    language: str | None = None
    role: str | None = None
    is_own: int | None = None
    metadata: dict[str, Any] | None = None


class ResolveRequest(BaseModel):
    link: str  # "@channel_name" or "https://t.me/..."


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_channel(row: dict[str, Any]) -> dict[str, Any]:
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_channels(
    _token: AdminAuth,
    db: WorkspaceDB,
    type_filter: str | None = Query(None, alias="type"),
    role: str | None = Query(None),
    category: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List channels with optional filters, search, and pagination."""
    conditions: list[str] = []
    params: list[Any] = []

    if type_filter:
        if type_filter not in VALID_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid type '{type_filter}'. Must be one of: {', '.join(sorted(VALID_TYPES))}",
            )
        conditions.append("type = ?")
        params.append(type_filter)

    if role:
        if role not in VALID_ROLES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid role '{role}'. Must be one of: {', '.join(sorted(VALID_ROLES))}",
            )
        conditions.append("role = ?")
        params.append(role)

    if category:
        conditions.append("category = ?")
        params.append(category)

    if search:
        conditions.append("(username LIKE ? OR title LIKE ? OR about LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like, like])

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_channels {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_channels {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_channel(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{channel_id}")
async def get_channel(
    channel_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single channel by ID."""
    row = db.execute(
        "SELECT * FROM tg_channels WHERE id = ?", [channel_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Channel not found")
    return _row_to_channel(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_channel(
    body: ChannelCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Add a channel manually (username or tg_id + metadata)."""
    if body.type not in VALID_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid type '{body.type}'. Must be one of: {', '.join(sorted(VALID_TYPES))}",
        )
    if body.role not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid role '{body.role}'. Must be one of: {', '.join(sorted(VALID_ROLES))}",
        )

    if not body.username and not body.tg_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either 'username' or 'tg_id' must be provided.",
        )

    now = _now()
    channel_id = str(uuid.uuid4())
    tags_json = json.dumps(body.tags or [])
    metadata_json = json.dumps(body.metadata) if body.metadata else None

    try:
        db.execute(
            """INSERT INTO tg_channels
                (id, tg_id, username, title, about, type, is_public,
                 members_count, avg_messages_day,
                 category, tags, language, role, is_own,
                 metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [channel_id, body.tg_id, body.username, body.title, body.about,
             body.type, body.is_public,
             body.members_count, body.avg_messages_day,
             body.category, tags_json, body.language, body.role, body.is_own,
             metadata_json, now, now],
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        if "UNIQUE constraint failed" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Channel with this tg_id already exists",
            )
        raise

    row = db.execute(
        "SELECT * FROM tg_channels WHERE id = ?", [channel_id]
    ).fetchone()

    log.info("channel_created", channel_id=channel_id, username=body.username, tg_id=body.tg_id)
    return _row_to_channel(row)


@router.post("/resolve")
async def resolve_channel(
    body: ResolveRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Resolve a channel link via Telethon and return channel info (does not save).

    Accepts: "@channel_name", "https://t.me/channel_name", "t.me/channel_name"
    """
    link = body.link.strip()

    # Normalize link to username
    username = link
    for prefix in ("https://t.me/", "http://t.me/", "t.me/"):
        if username.lower().startswith(prefix):
            username = username[len(prefix):]
            break
    if username.startswith("@"):
        username = username[1:]
    # Remove trailing slash or query params
    username = username.split("/")[0].split("?")[0]

    if not username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not extract channel username from link",
        )

    # Check if we already have it in DB
    existing = db.execute(
        "SELECT * FROM tg_channels WHERE username = ?", [username]
    ).fetchone()
    if existing:
        data = _row_to_channel(existing)
        data["source"] = "database"
        return data

    # Try Telethon resolve (requires an active account)
    try:
        from app.telegram.client_pool import get_any_client

        client = await get_any_client(db)
        entity = await client.get_entity(username)

        channel_type = "CHANNEL"
        if hasattr(entity, "megagroup") and entity.megagroup:
            channel_type = "SUPERGROUP"
        elif hasattr(entity, "gigagroup") and entity.gigagroup:
            channel_type = "CHANNEL"
        elif hasattr(entity, "forum") and entity.forum:
            channel_type = "FORUM"

        is_public = 1 if getattr(entity, "username", None) else 0
        members_count = getattr(entity, "participants_count", 0) or 0

        result = {
            "tg_id": entity.id,
            "username": getattr(entity, "username", None),
            "title": getattr(entity, "title", username),
            "about": None,
            "type": channel_type,
            "is_public": is_public,
            "members_count": members_count,
            "source": "telegram",
        }

        # Try to get full info for about
        try:
            full = await client.get_entity(entity.id)
            if hasattr(full, "about"):
                result["about"] = full.about
        except Exception:
            pass

        return result

    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Telethon client pool not available",
        )
    except Exception as exc:
        log.warning("channel_resolve_failed", username=username, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Could not resolve channel '@{username}': {exc}",
        )


@router.patch("/{channel_id}")
async def update_channel(
    channel_id: str,
    body: ChannelUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update channel fields. Only provided (non-None) fields are updated."""
    existing = db.execute(
        "SELECT id FROM tg_channels WHERE id = ?", [channel_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Channel not found")

    updates: dict[str, Any] = {}
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "tags" and value is not None:
            updates["tags"] = json.dumps(value)
        elif field == "metadata" and value is not None:
            updates["metadata"] = json.dumps(value)
        elif field == "type" and value is not None:
            if value not in VALID_TYPES:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid type '{value}'.",
                )
            updates["type"] = value
        elif field == "role" and value is not None:
            if value not in VALID_ROLES:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid role '{value}'.",
                )
            updates["role"] = value
        else:
            updates[field] = value

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No fields to update"
        )

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [channel_id]

    try:
        db.execute(
            f"UPDATE tg_channels SET {set_clause} WHERE id = ?", values
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_channels WHERE id = ?", [channel_id]
    ).fetchone()

    log.info("channel_updated", channel_id=channel_id)
    return _row_to_channel(row)


@router.delete("/{channel_id}")
async def delete_channel(
    channel_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a channel by ID."""
    existing = db.execute(
        "SELECT id FROM tg_channels WHERE id = ?", [channel_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Channel not found")

    try:
        db.execute("DELETE FROM tg_channels WHERE id = ?", [channel_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("channel_deleted", channel_id=channel_id)
    return {"status": "deleted", "id": channel_id}
