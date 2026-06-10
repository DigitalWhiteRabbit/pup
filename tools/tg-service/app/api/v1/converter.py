"""CRUD + control endpoints for format conversion tasks (TDATA/SESSION/SESSION_JSON)."""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/converter", tags=["converter"])

log = structlog.get_logger(__name__)

VALID_FORMATS = {"TDATA", "SESSION", "SESSION_JSON"}
VALID_STATUSES = {"DRAFT", "RUNNING", "COMPLETED", "FAILED"}

# UI direction tokens (e.g. "tdata_to_session_json") → (input_format, output_format).
# Order matters: "session_json" must be checked before "session".
_DIRECTION_TOKENS = (
    ("session_json", "SESSION_JSON"),
    ("tdata", "TDATA"),
    ("session", "SESSION"),
)


def _token_to_format(token: str) -> str | None:
    for tok, fmt in _DIRECTION_TOKENS:
        if token == tok:
            return fmt
    return None


def _parse_direction(direction: str) -> tuple[str, str]:
    """Parse a UI direction string like ``tdata_to_session_json`` into
    ``(input_format, output_format)``. Raises HTTP 400 on an unknown shape."""
    parts = direction.split("_to_")
    if len(parts) != 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid direction '{direction}'. Expected '<input>_to_<output>'.",
        )
    in_fmt = _token_to_format(parts[0])
    out_fmt = _token_to_format(parts[1])
    if not in_fmt or not out_fmt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid direction '{direction}'. Unknown format token.",
        )
    return in_fmt, out_fmt


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ConversionTaskCreate(BaseModel):
    name: str | None = None
    input_format: str
    output_format: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into an API-compatible dict."""
    data = dict(row)
    if data.get("errors"):
        try:
            data["errors"] = json.loads(data["errors"])
        except (json.JSONDecodeError, TypeError):
            data["errors"] = []
    else:
        data["errors"] = []
    return data


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/tasks")
async def list_tasks(
    _token: AdminAuth,
    db: WorkspaceDB,
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List conversion tasks."""
    conditions: list[str] = []
    params: list[Any] = []

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
        f"SELECT COUNT(*) AS total FROM tg_conversion_tasks {where}", params
    ).fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        f"SELECT * FROM tg_conversion_tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = [_row_to_dict(r) for r in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
    files: list[UploadFile] = File(default=[]),
    direction: str = Form(...),
    options: str = Form(default="{}"),
) -> dict[str, Any]:
    """Create a conversion task from a multipart upload.

    The UI posts ``files`` + ``direction`` (e.g. ``tdata_to_session_json``) +
    ``options`` (JSON). We parse the direction into input/output formats, persist
    the uploaded files under ``data/converter/<task_id>/`` for the worker to pick
    up, and create the task in DRAFT. (Actual format conversion is performed by
    the worker — see P4-11 for the real opentele-backed implementation.)
    """
    input_format, output_format = _parse_direction(direction)
    if input_format == output_format:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="input_format and output_format must be different.",
        )

    try:
        opts = json.loads(options) if options else {}
        if not isinstance(opts, dict):
            opts = {}
    except (json.JSONDecodeError, TypeError):
        opts = {}

    now = _now()
    task_id = str(uuid.uuid4())

    # Persist uploaded files so the worker can convert them later.
    work_dir = (settings.data_dir / "converter" / task_id).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    saved = 0
    for up in files:
        if not up.filename:
            continue
        safe_name = up.filename.replace("/", "_").replace("\\", "_")
        dest = work_dir / safe_name
        content = await up.read()
        dest.write_bytes(content)
        saved += 1

    name = opts.get("name") or f"{input_format}→{output_format}"

    try:
        db.execute(
            """INSERT INTO tg_conversion_tasks
                (id, name, input_format, output_format, files_count, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id, name, input_format, output_format, saved,
                "DRAFT", now, now,
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info(
        "conversion_task_created",
        task_id=task_id,
        input_format=input_format,
        output_format=output_format,
        files=saved,
    )
    return _row_to_dict(row)


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a conversion task."""
    existing = db.execute(
        "SELECT id FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Conversion task not found")

    try:
        db.execute("DELETE FROM tg_conversion_tasks WHERE id = ?", [task_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("conversion_task_deleted", task_id=task_id)
    return {"status": "deleted", "id": task_id}


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Set conversion task status to RUNNING and dispatch Celery task."""
    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversion task not found")

    if row["status"] not in ("DRAFT",):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot start task in status '{row['status']}'. Must be DRAFT.",
        )

    now = _now()

    # Dispatch first: a down engine raises 503 and leaves the task in its prior
    # status instead of falsely showing RUNNING.
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.converter_task", args=[workspace_id, task_id])

    try:
        db.execute(
            """UPDATE tg_conversion_tasks
               SET status = ?, started_at = ?, updated_at = ?
               WHERE id = ?""",
            ["RUNNING", now, now, task_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute(
        "SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()

    log.info("conversion_task_started", task_id=task_id)
    return _row_to_dict(row)


@router.get("/phone-country")
async def phone_country(
    phone: str,
    _token: AdminAuth,
) -> dict:
    """Return country code + name for a phone number (phonenumbers library)."""
    ph = phone.strip()
    if not ph.startswith("+"):
        ph = "+" + ph
    try:
        import phonenumbers
        from phonenumbers import geocoder, carrier

        parsed = phonenumbers.parse(ph)
        region = phonenumbers.region_code_for_number(parsed)
        country = geocoder.description_for_number(parsed, "ru") or region or "Unknown"
        carrier_name = carrier.name_for_number(parsed, "ru")
        valid = phonenumbers.is_valid_number(parsed)
        return {
            "phone": ph,
            "country_code": region,
            "country": country,
            "carrier": carrier_name or None,
            "valid": valid,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot parse phone number: {exc}",
        ) from exc


@router.get("/tasks/{task_id}/download")
async def download_task_files(
    task_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> StreamingResponse:
    """Stream all files for this conversion task as a ZIP archive.

    Works for both input (DRAFT/RUNNING) and output files. Session files
    stored encrypted are served as-is (the caller holds the key). Logs a
    download audit event to tg_audit_logs.
    """
    row = db.execute(
        "SELECT id, name, status FROM tg_conversion_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversion task not found")

    work_dir = (settings.data_dir / "converter" / task_id).resolve()
    data_root = settings.data_dir.resolve()
    if data_root not in work_dir.parents and work_dir != data_root:
        raise HTTPException(status_code=403, detail="Forbidden")

    if not work_dir.exists():
        raise HTTPException(status_code=404, detail="No files found for this task")

    files = [f for f in work_dir.rglob("*") if f.is_file()]
    if not files:
        raise HTTPException(status_code=404, detail="No files found for this task")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            arcname = f.relative_to(work_dir)
            zf.write(f, arcname)
    buf.seek(0)

    # Audit log
    try:
        db.execute(
            """INSERT INTO tg_audit_logs (id, event_type, severity, entity_type, entity_id,
               message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [str(uuid.uuid4()), "converter_download", "INFO", "conversion_task",
             task_id, f"Downloaded files for task '{row['name'] or task_id}'",
             datetime.now(timezone.utc).isoformat()],
        )
        db.commit()
    except Exception:
        pass

    filename = f"converter_{task_id[:8]}.zip"
    log.info("converter_download", task_id=task_id, files=len(files))
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
