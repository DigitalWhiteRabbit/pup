"""Message Templates — reusable text templates with spinning variants."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/templates", tags=["templates"])

log = structlog.get_logger(__name__)

VALID_CATEGORIES = {"DM", "CHAT_POST", "COMMENT", "AUTO_REPLY", "WELCOME"}
VALID_STATUSES = {"ACTIVE", "DRAFT", "ARCHIVED"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class TemplateCreate(BaseModel):
    name: str
    category: str = "DM"
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    language: str = "ru"
    ai_personalization: bool = False


class TemplateUpdate(BaseModel):
    name: str | None = None
    category: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    language: str | None = None
    ai_personalization: bool | None = None
    status: str | None = None


class VariantCreate(BaseModel):
    text: str
    position: int = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_template(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    if data.get("tags"):
        try:
            data["tags"] = json.loads(data["tags"])
        except (json.JSONDecodeError, TypeError):
            data["tags"] = []
    else:
        data["tags"] = []
    return data


def _row_to_variant(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Templates CRUD
# ---------------------------------------------------------------------------

@router.get("")
async def list_templates(
    _token: AdminAuth,
    db: WorkspaceDB,
    category: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List message templates with optional filters."""
    conditions: list[str] = []
    params: list[Any] = []

    if category:
        if category not in VALID_CATEGORIES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid category '{category}'. Must be one of: {', '.join(sorted(VALID_CATEGORIES))}",
            )
        conditions.append("category = ?")
        params.append(category)

    if status_filter:
        if status_filter not in VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status '{status_filter}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
            )
        conditions.append("status = ?")
        params.append(status_filter)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_row = db.execute(
        f"SELECT COUNT(*) AS total FROM tg_message_templates {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_message_templates {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_template(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single template with its variants."""
    row = db.execute(
        "SELECT * FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")

    variants = db.execute(
        "SELECT * FROM tg_template_variants WHERE template_id = ? ORDER BY position ASC",
        [template_id],
    ).fetchall()

    template = _row_to_template(row)
    template["variants"] = [_row_to_variant(v) for v in variants]
    return template


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Create a new message template."""
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid category '{body.category}'. Must be one of: {', '.join(sorted(VALID_CATEGORIES))}",
        )

    now = _now()
    template_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_message_templates
                (id, name, category, description, tags, language,
                 ai_personalization, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                template_id, body.name, body.category, body.description,
                json.dumps(body.tags), body.language,
                1 if body.ai_personalization else 0,
                "ACTIVE", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()

    log.info("template_created", template_id=template_id, name=body.name)
    return _row_to_template(row)


@router.patch("/{template_id}")
async def update_template(
    template_id: str,
    body: TemplateUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update an existing message template."""
    existing = db.execute(
        "SELECT id FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Template not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "category" in updates and updates["category"] not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid category '{updates['category']}'.",
        )
    if "status" in updates and updates["status"] not in VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status '{updates['status']}'.",
        )

    # Serialize JSON fields
    if "tags" in updates:
        updates["tags"] = json.dumps(updates["tags"])
    if "ai_personalization" in updates:
        updates["ai_personalization"] = 1 if updates["ai_personalization"] else 0

    updates["updated_at"] = _now()

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [template_id]

    try:
        db.execute(
            f"UPDATE tg_message_templates SET {set_clause} WHERE id = ?", params
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()

    log.info("template_updated", template_id=template_id)
    return _row_to_template(row)


@router.delete("/{template_id}")
async def delete_template(
    template_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a message template by ID (cascades to variants)."""
    existing = db.execute(
        "SELECT id FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Template not found")

    try:
        db.execute("DELETE FROM tg_message_templates WHERE id = ?", [template_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("template_deleted", template_id=template_id)
    return {"status": "deleted", "id": template_id}


# ---------------------------------------------------------------------------
# Variants
# ---------------------------------------------------------------------------

@router.post("/{template_id}/variants", status_code=status.HTTP_201_CREATED)
async def add_variant(
    template_id: str,
    body: VariantCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Add a variant to a template."""
    existing = db.execute(
        "SELECT id FROM tg_message_templates WHERE id = ?", [template_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Template not found")

    now = _now()
    variant_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_template_variants
                (id, template_id, position, text, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            [variant_id, template_id, body.position, body.text, now],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_template_variants WHERE id = ?", [variant_id]
    ).fetchone()

    log.info("variant_added", template_id=template_id, variant_id=variant_id)
    return _row_to_variant(row)


@router.delete("/{template_id}/variants/{variant_id}")
async def delete_variant(
    template_id: str,
    variant_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Remove a variant from a template."""
    existing = db.execute(
        "SELECT id FROM tg_template_variants WHERE id = ? AND template_id = ?",
        [variant_id, template_id],
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Variant not found")

    try:
        db.execute("DELETE FROM tg_template_variants WHERE id = ?", [variant_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("variant_deleted", template_id=template_id, variant_id=variant_id)
    return {"status": "deleted", "id": variant_id}


@router.post("/{template_id}/generate-variants")
async def generate_ai_variants(
    template_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    count: int = 3,
) -> dict:
    """Generate N AI variants for a template using Claude Haiku (P4-26)."""
    import uuid as _uuid

    row = db.execute(
        "SELECT * FROM tg_templates WHERE id = ?", [template_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")

    name = row["name"] or ""
    description = row["description"] or ""
    category = row["category"] or ""
    tags_raw = row["tags"] or "[]"

    # Build a context hint from existing variants
    existing_vars = db.execute(
        "SELECT text FROM tg_template_variants WHERE template_id = ? LIMIT 3", [template_id]
    ).fetchall()
    examples = "\n".join(f"- {r['text'][:120]}" for r in existing_vars)

    from app.ai.anthropic_client import generate_message

    system_prompt = (
        "You are a copywriter for Telegram DM campaigns. Generate varied, human-sounding "
        "message templates in Russian. Each variant should be different in tone and phrasing "
        "but convey the same core offer. Use placeholders like {first_name}, {username} where natural. "
        "Reply ONLY with a JSON array of strings — no prose, no markdown. "
        f"Generate exactly {count} variants."
    )
    user_message = (
        f"Template: {name}\n"
        f"Category: {category}\n"
        f"Description: {description}\n"
        f"Tags: {tags_raw}\n"
        + (f"Existing variants for reference:\n{examples}" if examples else "")
    )

    try:
        result = generate_message(
            system_prompt=system_prompt,
            user_message=user_message,
            model="claude-haiku-4-5-20251001",
            max_tokens=1000,
            temperature=1.0,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {exc}") from exc

    import json as _json
    import re as _re
    text = (result.get("text") or "").strip()
    match = _re.search(r"\[.*\]", text, _re.DOTALL)
    if not match:
        raise HTTPException(status_code=502, detail="AI returned unparseable response")

    try:
        variants = _json.loads(match.group(0))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI JSON parse error: {exc}") from exc

    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    saved = 0
    for v in variants[:count]:
        if not isinstance(v, str) or not v.strip():
            continue
        try:
            db.execute(
                "INSERT INTO tg_template_variants (id, template_id, text, created_at) VALUES (?, ?, ?, ?)",
                [str(_uuid.uuid4()), template_id, v.strip(), now],
            )
            saved += 1
        except Exception:
            pass

    db.execute(
        "UPDATE tg_templates SET updated_at=? WHERE id=?", [now, template_id]
    )
    db.commit()

    log.info("template_ai_variants_generated", template_id=template_id, count=saved)
    return {"generated": saved, "cost_usd": result.get("cost_usd")}
