"""Knowledge Base — documents, chunks, and keyword search for RAG."""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/kb", tags=["knowledge-base"])


def _dispatch_conflict_check(workspace_id: str, doc_id: str | None) -> None:
    """Best-effort dispatch of the KB consistency check.

    Never raises — a failed dispatch (e.g. Redis down) must not break the
    upload / create response.
    """
    # Best-effort: reuse the shared fail-fast dispatch (so a dead broker fails in
    # ~3s instead of hanging the upload), but swallow its 503 — this must never
    # break the upload / create response.
    from app.tasks.dispatch import dispatch_task

    try:
        dispatch_task("pup_tg.kb_check_conflicts", args=[workspace_id, doc_id])
        log.info("kb_conflict_check_dispatched", workspace_id=workspace_id, doc_id=doc_id)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "kb_conflict_check_dispatch_failed",
            workspace_id=workspace_id,
            doc_id=doc_id,
            error=str(exc)[:300],
        )


def _maybe_trigger_self_test(workspace_id: str, db: Any) -> None:
    """Auto-trigger a KB self-test after upload if conditions are met (P4-27).

    Conditions: ≥3 documents AND no self-test run in the last 6 hours.
    Best-effort — never raises.
    """
    try:
        doc_count = db.execute("SELECT COUNT(*) AS c FROM tg_kb_documents").fetchone()["c"]
        if doc_count < 3:
            return
        last_run = db.execute(
            "SELECT created_at FROM tg_kb_selftest_runs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if last_run:
            from datetime import datetime, timezone, timedelta
            try:
                last_dt = datetime.fromisoformat(last_run["created_at"].replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - last_dt) < timedelta(hours=6):
                    return  # recent run exists
            except Exception:
                pass

        import uuid as _uuid
        from app.tasks.dispatch import dispatch_task

        run_id = str(_uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat() if "datetime" in dir() else __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        db.execute(
            "INSERT INTO tg_kb_selftest_runs (id, status, created_at) VALUES (?, 'PENDING', ?)",
            [run_id, now],
        )
        db.commit()
        dispatch_task("pup_tg.kb_self_test", args=[workspace_id, run_id])
        log.info("kb_auto_self_test_triggered", workspace_id=workspace_id, run_id=run_id)
    except Exception as exc:
        log.warning("kb_auto_self_test_failed", error=str(exc)[:200])


log = structlog.get_logger(__name__)

# Chunking defaults
DEFAULT_CHUNK_SIZE = 500
DEFAULT_CHUNK_OVERLAP = 50

# File upload limits / supported types
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
SUPPORTED_EXTENSIONS = (".txt", ".md", ".pdf", ".docx")

_DOC_JSON_COLS = ("metadata",)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class DocumentCreate(BaseModel):
    title: str
    content: str
    path: str | None = None
    metadata: dict[str, Any] | None = None


class DocumentUpdate(BaseModel):
    title: str | None = None
    path: str | None = None
    metadata: dict[str, Any] | None = None


class RechunkRequest(BaseModel):
    chunk_size: int = Field(default=DEFAULT_CHUNK_SIZE, ge=50, le=5000)
    chunk_overlap: int = Field(default=DEFAULT_CHUNK_OVERLAP, ge=0, le=500)


class SearchRequest(BaseModel):
    query: str
    doc_ids: list[str] | None = None
    limit: int = Field(default=5, ge=1, le=100)


class CrawlRequest(BaseModel):
    url: str


class SiteRenameRequest(BaseModel):
    site: str
    new_name: str


class CheckConflictsRequest(BaseModel):
    doc_id: str | None = None


class ResolveConflictRequest(BaseModel):
    action: str  # keep_both | delete_a | delete_b | dismiss


class MergeDocumentsRequest(BaseModel):
    doc_a_id: str
    doc_b_id: str
    title: str | None = None


class ChunkResult(BaseModel):
    id: str
    document_id: str
    document_title: str | None = None
    position: int
    text: str
    score: int = 0  # number of keyword hits


class ChatRequest(BaseModel):
    message: str
    mode: str = Field(default="strict", pattern="^(strict|free)$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row_to_doc(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into a document dict."""
    data = dict(row)
    for col in _DOC_JSON_COLS:
        if data.get(col):
            try:
                data[col] = json.loads(data[col])
            except (json.JSONDecodeError, TypeError):
                data[col] = None
        else:
            data[col] = None
    return data


def _row_to_chunk(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw SQLite row dict into a chunk dict."""
    data = dict(row)
    # Drop the binary embedding column from API responses
    data.pop("embedding", None)
    return data


def _split_into_chunks(
    content: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    """Split content into chunks, preferring sentence/newline boundaries.

    - Chunk size: ``chunk_size`` characters
    - Overlap: ``overlap`` characters carried over from the previous chunk
    - Splits on `. ` or `\\n` near the chunk boundary when possible
    """
    if not content:
        return []

    chunks: list[str] = []
    start = 0
    text_len = len(content)

    while start < text_len:
        end = start + chunk_size

        if end >= text_len:
            # Last chunk — take everything remaining
            chunks.append(content[start:].strip())
            break

        # Try to find a sentence boundary (`. ` or `\n`) in the last 20% of the chunk
        search_start = start + int(chunk_size * 0.8)
        segment = content[search_start:end]

        # Prefer newline, then sentence end
        best_break = -1
        newline_pos = segment.rfind("\n")
        if newline_pos != -1:
            best_break = newline_pos + 1  # include the newline in previous chunk
        else:
            sentence_pos = segment.rfind(". ")
            if sentence_pos != -1:
                best_break = sentence_pos + 2  # include ". " in previous chunk

        if best_break != -1:
            actual_end = search_start + best_break
        else:
            actual_end = end

        chunk_text = content[start:actual_end].strip()
        if chunk_text:
            chunks.append(chunk_text)

        # Next chunk starts with overlap
        start = max(actual_end - overlap, start + 1)

    return chunks


def _create_chunks(
    db: Any,
    document_id: str,
    content: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> int:
    """Split content into chunks and insert them into the DB.

    Returns the number of chunks created.
    """
    texts = _split_into_chunks(content, chunk_size, overlap)

    # P6-01: best-effort local embeddings. NULL when unavailable → the hybrid
    # retriever transparently falls back to keyword scoring for that chunk.
    from app.ai import embeddings as emb

    blobs = emb.embed_batch(texts) if texts else []

    for position, text in enumerate(texts):
        chunk_id = str(uuid.uuid4())
        blob = blobs[position] if position < len(blobs) else None
        db.execute(
            """INSERT INTO tg_kb_chunks (id, document_id, position, text, embedding, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [chunk_id, document_id, position, text, blob, _now()],
        )

    return len(texts)


def _persist_document(
    db: Any,
    title: str,
    content: str,
    path: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], int]:
    """Insert a document and its chunks, then commit (shared create path).

    Used by both JSON create and file upload so the chunk + insert logic
    lives in exactly one place. Returns ``(document_row_dict, chunks_count)``.
    Rolls back on error and re-raises.
    """
    now = _now()
    doc_id = str(uuid.uuid4())

    try:
        db.execute(
            """INSERT INTO tg_kb_documents
                (id, title, path, content, metadata, chunks_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                doc_id,
                title,
                path,
                content,
                json.dumps(metadata) if metadata else None,
                0,
                now,
                now,
            ],
        )

        chunks_count = _create_chunks(db, doc_id, content)

        db.execute(
            "UPDATE tg_kb_documents SET chunks_count = ? WHERE id = ?",
            [chunks_count, doc_id],
        )

        db.commit()
    except Exception:
        db.rollback()
        raise

    row = db.execute("SELECT * FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()

    # Audit log (non-critical)
    try:
        db.execute(
            """INSERT INTO tg_audit_logs
                (event_type, severity, entity_type, entity_id, message, metadata)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                "kb.document_created",
                "INFO",
                "kb_document",
                doc_id,
                f"Document '{title}' created with {chunks_count} chunks",
                json.dumps(
                    {
                        "title": title,
                        "chunks_count": chunks_count,
                        "content_length": len(content),
                    }
                ),
            ],
        )
        db.commit()
    except Exception:
        pass

    return _row_to_doc(row), chunks_count


def _extract_text_from_upload(filename: str, ext: str, raw: bytes) -> str:
    """Extract plain text from uploaded file bytes by extension.

    PDF/DOCX deps are imported lazily so the module still imports when they
    are missing; a missing dep raises HTTP 501.
    """
    if ext in (".txt", ".md"):
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("latin-1", errors="replace")

    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="PDF/DOCX support not installed",
            ) from exc

        import io

        reader = PdfReader(io.BytesIO(raw))
        parts = [page.extract_text() or "" for page in reader.pages]
        return "\n".join(parts)

    if ext == ".docx":
        try:
            import docx
        except ImportError as exc:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="PDF/DOCX support not installed",
            ) from exc

        import io

        document = docx.Document(io.BytesIO(raw))
        return "\n".join(p.text for p in document.paragraphs)

    # Should be unreachable — caller validates the extension first.
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Unsupported file type",
    )


def _retrieve_chunks(
    db: Any,
    query: str,
    limit: int = 6,
    doc_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Rank chunks for *query* (shared by /kb/search and /kb/chat).

    P6-01: hybrid keyword + local vector retrieval via the shared ``kb_search``
    service (falls back to keyword-only when embeddings are unavailable). Each
    result carries its parent document title + metadata (for the document URL).
    """
    from app.services.kb_search import hybrid_retrieve

    return hybrid_retrieve(db, query, limit=limit, doc_ids=doc_ids)


def _doc_url_from_metadata(raw_metadata: str | None) -> str | None:
    """Extract a ``url`` from a document's JSON metadata column, if present."""
    if not raw_metadata:
        return None
    try:
        meta = json.loads(raw_metadata)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(meta, dict):
        url = meta.get("url")
        return url if isinstance(url, str) else None
    return None


# ---------------------------------------------------------------------------
# Documents CRUD
# ---------------------------------------------------------------------------


@router.post("/documents", status_code=status.HTTP_201_CREATED)
async def create_document(
    body: DocumentCreate,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Upload a document (title + content). Auto-splits into chunks."""
    doc, chunks_count = _persist_document(
        db, body.title, body.content, path=body.path, metadata=body.metadata
    )
    log.info("kb_document_created", doc_id=doc["id"], title=body.title, chunks=chunks_count)
    # Best-effort consistency check against the rest of the base.
    _dispatch_conflict_check(workspace_id, doc["id"])
    return doc


@router.post("/documents/upload", status_code=status.HTTP_201_CREATED)
async def upload_document(
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
    file: UploadFile = File(...),
    title: str | None = Form(None),
) -> dict[str, Any]:
    """Upload a file (.txt/.md/.pdf/.docx), extract text, chunk, and store.

    Shares the chunk + insert path with ``create_document`` via
    ``_persist_document``.
    """
    filename = file.filename or "upload"
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""

    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported file type",
        )

    raw = await file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum size of {MAX_UPLOAD_BYTES} bytes",
        )

    content = _extract_text_from_upload(filename, ext, raw)
    if not content or not content.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No extractable text",
        )

    resolved_title = (title or "").strip() or filename.rsplit(".", 1)[0]

    doc, chunks_count = _persist_document(
        db,
        resolved_title,
        content,
        metadata={"source": "upload", "filename": filename, "ext": ext},
    )

    log.info(
        "kb_file_uploaded",
        title=resolved_title,
        ext=ext,
        chars=len(content),
        chunks=chunks_count,
    )

    # Best-effort consistency check against the rest of the base.
    _dispatch_conflict_check(workspace_id, doc["id"])
    # Auto self-test if KB is large enough (P4-27)
    _maybe_trigger_self_test(workspace_id, db)

    return {
        **doc,
        "id": doc["id"],
        "title": resolved_title,
        "chunks_count": chunks_count,
    }


@router.get("/documents")
async def list_documents(
    _token: AdminAuth,
    db: WorkspaceDB,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """List all documents with pagination.

    Each item includes its parsed ``metadata`` (``source``, ``site``, ``url``,
    ``crawl_job_id`` for crawled pages) so the UI can group crawl documents by
    ``site``. ``content`` is intentionally omitted from the list to keep the
    payload small — fetch a single document to get its full text.
    """
    count_row = db.execute("SELECT COUNT(*) AS total FROM tg_kb_documents").fetchone()
    total = count_row["total"] if count_row else 0

    rows = db.execute(
        """SELECT id, title, path, metadata, chunks_count, created_at, updated_at
           FROM tg_kb_documents
           ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        [limit, offset],
    ).fetchall()

    # _row_to_doc parses the metadata JSON column (source/site/url/...).
    items = [_row_to_doc(r) for r in rows]

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/documents/{doc_id}")
async def get_document(
    doc_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Get a single document with its full content, metadata, and chunks.

    Returns the assembled ``content`` (the collected/rendered text), ``title``
    and parsed ``metadata`` (``source``/``site``/``url``/...) so the UI can show
    the gathered text in a modal. ``SELECT *`` includes the ``content`` column.
    """
    row = db.execute("SELECT * FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")

    doc = _row_to_doc(row)

    chunks = db.execute(
        "SELECT * FROM tg_kb_chunks WHERE document_id = ? ORDER BY position ASC",
        [doc_id],
    ).fetchall()
    doc["chunks"] = [_row_to_chunk(c) for c in chunks]

    return doc


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Delete a document and its chunks (CASCADE)."""
    existing = db.execute("SELECT id, title FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")

    title = existing["title"]

    try:
        db.execute("DELETE FROM tg_kb_documents WHERE id = ?", [doc_id])
        db.commit()
    except Exception:
        db.rollback()
        raise

    # Audit log
    try:
        db.execute(
            """INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                "kb.document_deleted",
                "INFO",
                "kb_document",
                doc_id,
                f"Document '{title}' deleted",
                json.dumps({"title": title}),
            ],
        )
        db.commit()
    except Exception:
        pass

    log.info("kb_document_deleted", doc_id=doc_id, title=title)
    return {"status": "deleted", "id": doc_id}


@router.post("/documents/{doc_id}/rechunk")
async def rechunk_document(
    doc_id: str,
    body: RechunkRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Re-split an existing document into chunks with new parameters."""
    row = db.execute("SELECT * FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")

    if body.chunk_overlap >= body.chunk_size:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="chunk_overlap must be less than chunk_size",
        )

    try:
        # Delete existing chunks
        db.execute("DELETE FROM tg_kb_chunks WHERE document_id = ?", [doc_id])

        # Create new chunks
        chunks_count = _create_chunks(
            db,
            doc_id,
            row["content"],
            chunk_size=body.chunk_size,
            overlap=body.chunk_overlap,
        )

        # Update document
        db.execute(
            "UPDATE tg_kb_documents SET chunks_count = ?, updated_at = ? WHERE id = ?",
            [chunks_count, _now(), doc_id],
        )

        db.commit()
    except Exception:
        db.rollback()
        raise

    # Re-fetch
    updated = db.execute("SELECT * FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    doc = _row_to_doc(updated)

    chunks = db.execute(
        "SELECT * FROM tg_kb_chunks WHERE document_id = ? ORDER BY position ASC",
        [doc_id],
    ).fetchall()
    doc["chunks"] = [_row_to_chunk(c) for c in chunks]

    log.info(
        "kb_document_rechunked",
        doc_id=doc_id,
        chunk_size=body.chunk_size,
        overlap=body.chunk_overlap,
        chunks_count=chunks_count,
    )
    return doc


@router.patch("/documents/{doc_id}")
async def update_document(
    doc_id: str,
    body: DocumentUpdate,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Update a document's metadata fields (primarily ``title``).

    Only the fields present in the request body are touched
    (``model_dump(exclude_unset=True)``). ``title`` is trimmed and rejected
    when empty. ``metadata`` is stored as a JSON string. Returns the updated
    document (same shape as ``get_document``).
    """
    row = db.execute("SELECT id FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")

    fields = body.model_dump(exclude_unset=True)

    set_parts: list[str] = []
    params: list[Any] = []

    if "title" in fields:
        title = (fields["title"] or "").strip()
        if not title:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Title must not be empty",
            )
        set_parts.append("title = ?")
        params.append(title)

    if "path" in fields:
        set_parts.append("path = ?")
        params.append(fields["path"])

    if "metadata" in fields:
        meta = fields["metadata"]
        set_parts.append("metadata = ?")
        params.append(json.dumps(meta) if meta is not None else None)

    if set_parts:
        set_parts.append("updated_at = ?")
        params.append(_now())
        params.append(doc_id)
        try:
            db.execute(
                f"UPDATE tg_kb_documents SET {', '.join(set_parts)} WHERE id = ?",
                params,
            )
            db.commit()
        except Exception:
            db.rollback()
            raise

    updated = db.execute("SELECT * FROM tg_kb_documents WHERE id = ?", [doc_id]).fetchone()
    doc = _row_to_doc(updated)

    log.info("kb_document_renamed", doc_id=doc_id, fields=list(fields.keys()))
    return doc


@router.post("/site/rename")
async def rename_site(
    body: SiteRenameRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, int]:
    """Rename a crawled-site group by rewriting each page's ``metadata.site``.

    Matches every document whose ``metadata.source == "crawl"`` and whose
    ``metadata.site`` equals the given ``site`` (an empty/missing ``site``
    matches the unnamed "(сайт)" group). Grouping in the UI is by
    ``metadata.site``, so after the rewrite all matched pages regroup under
    ``new_name`` automatically.
    """
    new_name = body.new_name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="new_name must not be empty",
        )

    target_site = body.site

    rows = db.execute(
        "SELECT id, metadata FROM tg_kb_documents WHERE metadata IS NOT NULL"
    ).fetchall()

    updated = 0
    try:
        for row in rows:
            try:
                meta = json.loads(row["metadata"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(meta, dict):
                continue
            if meta.get("source") != "crawl":
                continue
            if (meta.get("site") or "") != target_site:
                continue

            meta["site"] = new_name
            db.execute(
                "UPDATE tg_kb_documents SET metadata = ?, updated_at = ? WHERE id = ?",
                [json.dumps(meta), _now(), row["id"]],
            )
            updated += 1

        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("kb_site_renamed", site=target_site, new_name=new_name, count=updated)
    return {"updated": updated}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@router.post("/search")
async def search_chunks(
    body: SearchRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Hybrid search across chunks (P6-01).

    Keyword + local vector cosine over the chunk ``embedding`` column via the
    shared ``kb_search`` service; falls back to keyword-only when embeddings are
    unavailable. ``mode`` in the response reports which path ran.
    """
    from app.ai import embeddings as emb
    from app.services.kb_search import hybrid_retrieve

    query = body.query.strip()
    if not query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Query must not be empty",
        )

    items = hybrid_retrieve(db, query, limit=body.limit, doc_ids=body.doc_ids or None)
    mode = "hybrid" if emb.is_available() else "keyword"
    return {"items": items, "total": len(items), "query": query, "mode": mode}


@router.post("/reembed")
async def reembed_chunks(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Backfill local embeddings for chunks missing one (P6-01).

    Idempotent: only chunks with NULL ``embedding`` are processed. Returns 503
    if the embedding model is unavailable (so the caller knows nothing changed).
    """
    from app.ai import embeddings as emb

    if not emb.is_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Embedding model unavailable (fastembed not installed / model not loadable)",
        )

    rows = db.execute(
        "SELECT id, text FROM tg_kb_chunks WHERE embedding IS NULL"
    ).fetchall()
    if not rows:
        return {"embedded": 0, "remaining": 0}

    embedded = 0
    # Batch to keep memory bounded on large KBs.
    batch = 128
    for i in range(0, len(rows), batch):
        slice_ = rows[i : i + batch]
        blobs = emb.embed_batch([r["text"] for r in slice_])
        for r, blob in zip(slice_, blobs):
            if blob is None:
                continue
            db.execute(
                "UPDATE tg_kb_chunks SET embedding = ? WHERE id = ?", [blob, r["id"]]
            )
            embedded += 1
        db.commit()

    remaining = db.execute(
        "SELECT COUNT(*) AS n FROM tg_kb_chunks WHERE embedding IS NULL"
    ).fetchone()["n"]
    log.info("kb_reembed_done", embedded=embedded, remaining=remaining)
    return {"embedded": embedded, "remaining": remaining}


# ---------------------------------------------------------------------------
# Website crawler
# ---------------------------------------------------------------------------


@router.post("/crawl", status_code=status.HTTP_202_ACCEPTED)
async def start_crawl(
    body: CrawlRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, str]:
    """Crawl a whole website (all same-domain pages) into the Knowledge Base.

    Validates the URL (http/https + SSRF) up front, records a PENDING crawl
    job, and dispatches the Celery ``pup_tg.kb_crawl`` task. If the dispatch
    fails (e.g. Redis down), the job row is marked FAILED and a 503 returned —
    we never persist a PENDING job that no worker will ever pick up.
    """
    # SSRF + scheme validation BEFORE creating any row (lazy import: the task
    # module pulls in httpx/bs4 helpers we don't want at API import time).
    from app.tasks.kb_crawl_tasks import SSRFError, validate_url_ssrf

    url = body.url.strip()
    try:
        validate_url_ssrf(url)
    except SSRFError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"URL rejected: {exc}",
        ) from exc

    job_id = str(uuid.uuid4())

    # Insert the PENDING job first so we have a row to flip to FAILED if the
    # dispatch raises, then attempt dispatch, then commit.
    db.execute(
        """INSERT INTO tg_kb_crawl_jobs (id, url, status, created_at)
           VALUES (?, ?, 'PENDING', ?)""",
        [job_id, url, _now()],
    )

    # Reuse the shared fail-fast dispatch; on failure flip the job to FAILED so
    # we never leave a PENDING crawl no worker will pick up.
    from app.tasks.dispatch import dispatch_task

    try:
        dispatch_task("pup_tg.kb_crawl", args=[workspace_id, job_id, url])
    except HTTPException:
        db.execute(
            """UPDATE tg_kb_crawl_jobs
               SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?""",
            ["Dispatch failed: engine unavailable", _now(), job_id],
        )
        db.commit()
        log.warning("kb_crawl_dispatch_failed", job_id=job_id)
        raise

    db.commit()
    log.info("kb_crawl_dispatched", job_id=job_id, url=url, workspace_id=workspace_id)
    return {"job_id": job_id, "status": "PENDING"}


@router.get("/crawl/{job_id}")
async def get_crawl(
    job_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return the status/progress of a crawl job."""
    row = db.execute(
        """SELECT status, pages_found, pages_done, documents_created, error, url
           FROM tg_kb_crawl_jobs WHERE id = ?""",
        [job_id],
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Crawl job not found")
    return dict(row)


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@router.get("/stats")
async def kb_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return knowledge base statistics."""
    total_docs = db.execute("SELECT COUNT(*) AS cnt FROM tg_kb_documents").fetchone()["cnt"]

    total_chunks = db.execute("SELECT COUNT(*) AS cnt FROM tg_kb_chunks").fetchone()["cnt"]

    size_row = db.execute(
        "SELECT COALESCE(SUM(LENGTH(content)), 0) AS total_size FROM tg_kb_documents"
    ).fetchone()
    total_content_size = size_row["total_size"]

    return {
        "total_documents": total_docs,
        "total_chunks": total_chunks,
        "total_content_size": total_content_size,
    }


# ---------------------------------------------------------------------------
# Consistency check — duplicates & contradictions
# ---------------------------------------------------------------------------


@router.post("/check-conflicts", status_code=status.HTTP_202_ACCEPTED)
async def check_conflicts(
    body: CheckConflictsRequest,
    _token: AdminAuth,
    workspace_id: WorkspaceId,
) -> dict[str, str]:
    """Dispatch a KB consistency check (Claude duplicate/contradiction scan).

    If ``doc_id`` is given, that document is compared against all others;
    otherwise the whole base is checked. Dispatch-failure tolerant.
    """
    # Reuse the shared fail-fast dispatch (raises 503 if the engine is down).
    from app.tasks.dispatch import dispatch_task

    dispatch_task("pup_tg.kb_check_conflicts", args=[workspace_id, body.doc_id])

    log.info(
        "kb_check_conflicts_dispatched",
        workspace_id=workspace_id,
        doc_id=body.doc_id,
    )
    return {"status": "started"}


@router.get("/conflicts")
async def list_conflicts(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return all OPEN conflicts (duplicates + contradictions)."""
    rows = db.execute(
        """SELECT id, conflict_type, doc_a_id, doc_a_title, doc_b_id, doc_b_title,
                  summary, quote_a, quote_b, conflict_field, value_a, value_b,
                  created_at
           FROM tg_kb_conflicts
           WHERE status = 'open'
           ORDER BY created_at DESC""",
    ).fetchall()
    items = [dict(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.post("/documents/merge", status_code=status.HTTP_201_CREATED)
async def merge_documents(
    body: MergeDocumentsRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Merge two documents into one, deleting the originals.

    Loads both documents (404 if either is missing), concatenates their content
    with a labelled separator, creates ONE new document (via the shared
    ``_persist_document`` chunk+insert path), deletes both originals (chunks
    cascade), and marks any OPEN conflicts referencing either original as
    ``resolved``. Returns the new document's id/title/chunks_count.
    """
    doc_a = db.execute(
        "SELECT id, title, content FROM tg_kb_documents WHERE id = ?", [body.doc_a_id]
    ).fetchone()
    if not doc_a:
        raise HTTPException(status_code=404, detail="Document A not found")

    doc_b = db.execute(
        "SELECT id, title, content FROM tg_kb_documents WHERE id = ?", [body.doc_b_id]
    ).fetchone()
    if not doc_b:
        raise HTTPException(status_code=404, detail="Document B not found")

    title_a = doc_a["title"] or "Документ A"
    title_b = doc_b["title"] or "Документ B"
    merged_title = (body.title or "").strip() or title_a

    merged_content = (
        f"--- (источник: {title_a}) ---\n\n"
        f"{doc_a['content'] or ''}"
        f"\n\n--- (источник: {title_b}) ---\n\n"
        f"{doc_b['content'] or ''}"
    )

    # Create the merged document (+ chunks, committed inside the helper).
    doc, chunks_count = _persist_document(
        db,
        merged_title,
        merged_content,
        metadata={"source": "merge", "merged_from": [body.doc_a_id, body.doc_b_id]},
    )

    # Delete the two originals (chunks cascade) and resolve their open conflicts.
    try:
        db.execute(
            "DELETE FROM tg_kb_documents WHERE id IN (?, ?)",
            [body.doc_a_id, body.doc_b_id],
        )
        db.execute(
            """UPDATE tg_kb_conflicts SET status = 'resolved'
               WHERE status = 'open'
                 AND (doc_a_id IN (?, ?) OR doc_b_id IN (?, ?))""",
            [body.doc_a_id, body.doc_b_id, body.doc_a_id, body.doc_b_id],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info(
        "kb_documents_merged",
        new_doc_id=doc["id"],
        doc_a_id=body.doc_a_id,
        doc_b_id=body.doc_b_id,
        chunks_count=chunks_count,
    )
    return {"id": doc["id"], "title": merged_title, "chunks_count": chunks_count}


@router.post("/conflicts/{conflict_id}/resolve")
async def resolve_conflict(
    conflict_id: str,
    body: ResolveConflictRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, str]:
    """Resolve a conflict.

    Actions:
      - ``keep_both`` → mark resolved (both docs kept).
      - ``dismiss``   → mark dismissed (not a real conflict).
      - ``delete_a``  → delete doc_a (+ chunks via CASCADE), mark resolved.
      - ``delete_b``  → delete doc_b (+ chunks via CASCADE), mark resolved.
    """
    action = (body.action or "").strip().lower()
    if action not in ("keep_both", "delete_a", "delete_b", "dismiss"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid action",
        )

    row = db.execute(
        "SELECT id, doc_a_id, doc_b_id FROM tg_kb_conflicts WHERE id = ?",
        [conflict_id],
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conflict not found")

    try:
        if action == "delete_a" and row["doc_a_id"]:
            # tg_kb_chunks has ON DELETE CASCADE on document_id.
            db.execute("DELETE FROM tg_kb_documents WHERE id = ?", [row["doc_a_id"]])
            db.execute(
                "UPDATE tg_kb_conflicts SET status = 'resolved' WHERE id = ?",
                [conflict_id],
            )
        elif action == "delete_b" and row["doc_b_id"]:
            db.execute("DELETE FROM tg_kb_documents WHERE id = ?", [row["doc_b_id"]])
            db.execute(
                "UPDATE tg_kb_conflicts SET status = 'resolved' WHERE id = ?",
                [conflict_id],
            )
        elif action == "dismiss":
            db.execute(
                "UPDATE tg_kb_conflicts SET status = 'dismissed' WHERE id = ?",
                [conflict_id],
            )
        else:  # keep_both (or delete_* with a missing doc id)
            db.execute(
                "UPDATE tg_kb_conflicts SET status = 'resolved' WHERE id = ?",
                [conflict_id],
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("kb_conflict_resolved", conflict_id=conflict_id, action=action)
    return {"status": "ok", "action": action}


# ---------------------------------------------------------------------------
# Test-Chat (RAG: retrieve KB chunks → answer with Claude → cite sources)
# ---------------------------------------------------------------------------

# Haiku model id (resolves the short alias used elsewhere to a real model id).
_CHAT_MODEL = "claude-haiku-4-5-20251001"

# How many chunks to retrieve and how many recent turns to keep as context.
_CHAT_TOP_K = 6
_CHAT_HISTORY_TURNS = 6
_CHUNK_CONTEXT_CHARS = 1200  # per-chunk cap inside the prompt context block
_SNIPPET_CHARS = 300  # per-chunk cap stored in sources for the UI

# Whole-base context budget. When the combined content of ALL documents fits
# within this many characters we feed the entire base to Claude (so cross-lingual
# matches like RU "циклы" ↔ EN "Smart Cycle" are never missed). Above the budget
# we fall back to keyword top-K retrieval so large bases still work.
_WHOLE_BASE_CHAR_BUDGET = 60000
_FULL_DOC_SNIPPET_CHARS = 300  # leading chars of each doc stored in sources

_CHAT_SYSTEM_STRICT = (
    "Ты — ассистент базы знаний. Отвечай ИСКЛЮЧИТЕЛЬНО на основе предоставленного "
    "ниже контекста из базы знаний. НЕ используй внешние знания и ничего не "
    "придумывай. Если ответа нет в контексте, ответь ровно одной фразой: "
    '"В базе знаний нет информации по этому вопросу" — без каких-либо дополнений. '
    "Отвечай на языке вопроса пользователя (обычно русский). Будь точным и кратким."
)

_CHAT_SYSTEM_FREE = (
    "Ты — ассистент базы знаний. В первую очередь опирайся на предоставленный ниже "
    "контекст из базы знаний. Если контекста недостаточно, можешь дополнить ответ "
    "своими общими знаниями, но обязательно отметь, что это дополнение вне базы "
    "знаний (например, фразой «вне базы знаний:»). Отвечай на языке вопроса "
    "пользователя (обычно русский). Будь точным и полезным."
)

_NO_INFO_ANSWER = "В базе знаний нет информации по этому вопросу"


def _row_to_chat_message(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a raw chat-message row into an API dict (parses ``sources``)."""
    data = dict(row)
    raw = data.get("sources")
    if raw:
        try:
            data["sources"] = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            data["sources"] = []
    else:
        data["sources"] = []
    return data


def _build_whole_base_context(
    db: Any,
) -> tuple[str | None, list[dict[str, Any]]]:
    """Load EVERY document's full content as one context block.

    Returns ``(context_block, sources)`` where ``sources`` is one entry per
    document (``doc_id``, ``title``, ``url``, short ``snippet``). Returns
    ``(None, [])`` when the combined content exceeds
    :data:`_WHOLE_BASE_CHAR_BUDGET` — the caller then falls back to keyword
    retrieval. Returns ``("", [])`` when the base is empty.
    """
    rows = db.execute(
        """SELECT id, title, content, metadata
           FROM tg_kb_documents
           ORDER BY created_at ASC"""
    ).fetchall()

    if not rows:
        return "", []

    total = sum(len(r["content"] or "") for r in rows)
    if total > _WHOLE_BASE_CHAR_BUDGET:
        return None, []

    context_parts: list[str] = []
    sources: list[dict[str, Any]] = []
    for row in rows:
        title = row["title"] or "Без названия"
        content = (row["content"] or "").strip()
        context_parts.append(f"[Документ: {title}]\n{content}")
        sources.append(
            {
                "doc_id": row["id"],
                "title": title,
                "url": _doc_url_from_metadata(row["metadata"]),
                "snippet": content[:_FULL_DOC_SNIPPET_CHARS],
            }
        )

    return "\n\n---\n\n".join(context_parts), sources


def _build_keyword_context(db: Any, question: str) -> tuple[str, list[dict[str, Any]]]:
    """Keyword top-K fallback: build a context block + per-document sources.

    Dedups sources by document so multiple chunks of one doc collapse into a
    single source entry (matching the whole-base shape).
    """
    chunks = _retrieve_chunks(db, question, limit=_CHAT_TOP_K)

    context_parts: list[str] = []
    sources: list[dict[str, Any]] = []
    seen_docs: set[str] = set()
    for chunk in chunks:
        title = chunk.get("document_title") or "Без названия"
        text = (chunk.get("text") or "").strip()
        context_parts.append(f"[Документ: {title}]\n{text[:_CHUNK_CONTEXT_CHARS]}")
        doc_id = chunk.get("document_id")
        if doc_id not in seen_docs:
            seen_docs.add(doc_id)
            sources.append(
                {
                    "doc_id": doc_id,
                    "title": title,
                    "url": _doc_url_from_metadata(chunk.get("document_metadata")),
                    "snippet": text[:_SNIPPET_CHARS],
                }
            )
    context_block = "\n\n---\n\n".join(context_parts) if context_parts else ""
    return context_block, sources


def answer_question_against_base(
    db: Any,
    question: str,
    mode: str = "strict",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Answer *question* using the WHOLE knowledge base as Claude context.

    Shared by ``/kb/chat`` and the KB self-test task so the retrieval strategy
    lives in exactly one place. Loads every document's full content when it fits
    the char budget; otherwise falls back to keyword top-K retrieval. Logs which
    path was used. ``history`` is an optional list of ``{role, content}`` turns
    (chronological) prepended to the prompt for dialog continuity.

    Returns ``(answer, sources)`` where ``sources`` is one entry per document
    used as context (``doc_id``, ``title``, ``url``, ``snippet``). In strict mode
    with no usable context the canonical "no info" answer is returned with empty
    sources and Claude is not called.
    """
    context_block, sources = _build_whole_base_context(db)
    if context_block is None:
        # Base exceeds the budget — fall back to keyword retrieval.
        context_block, sources = _build_keyword_context(db, question)
        retrieval = "keyword_fallback"
    else:
        retrieval = "whole_base"

    log.info(
        "kb_retrieval_path",
        path=retrieval,
        sources=len(sources),
        context_chars=len(context_block),
    )

    # Strict mode with no usable context → canonical "no info", skip the LLM.
    if mode == "strict" and not context_block:
        return _NO_INFO_ANSWER, []

    context_for_prompt = context_block or "(контекст пуст)"

    history_block = ""
    if history:
        history_block = "\n".join(
            f"{'Пользователь' if h.get('role') == 'user' else 'Ассистент'}: "
            f"{h.get('content', '')}"
            for h in history
        )

    system_prompt = _CHAT_SYSTEM_STRICT if mode == "strict" else _CHAT_SYSTEM_FREE

    user_prompt_parts = ["КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ:", context_for_prompt]
    if history_block:
        user_prompt_parts += ["", "ИСТОРИЯ ДИАЛОГА:", history_block]
    user_prompt_parts += ["", "ВОПРОС ПОЛЬЗОВАТЕЛЯ:", question]
    user_prompt = "\n".join(user_prompt_parts)

    from app.ai.anthropic_client import generate_message

    result = generate_message(
        system_prompt=system_prompt,
        user_message=user_prompt,
        model=_CHAT_MODEL,
        max_tokens=1024,
        temperature=0.3,
    )
    answer = (result.get("text") or "").strip()

    if not answer:
        answer = _NO_INFO_ANSWER if mode == "strict" else "Не удалось сформировать ответ."

    return answer, sources


@router.post("/chat")
async def kb_chat(
    body: ChatRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """RAG test-chat: retrieve KB chunks, answer with Claude, cite sources.

    Persists both the user message and the assistant answer (with sources +
    mode) to ``tg_kb_chat_messages`` so the dialog has continuity and history.
    """
    message = body.message.strip()
    if not message:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message must not be empty",
        )

    mode = body.mode if body.mode in ("strict", "free") else "strict"

    # (b) Persist the user message.
    user_id = str(uuid.uuid4())
    try:
        db.execute(
            """INSERT INTO tg_kb_chat_messages (id, role, content, sources, mode, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [user_id, "user", message, None, None, _now()],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    # (c) Pull recent dialog history for continuity (chronological, capped).
    hist_rows = db.execute(
        """SELECT role, content FROM tg_kb_chat_messages
           WHERE id != ?
           ORDER BY created_at DESC LIMIT ?""",
        [user_id, _CHAT_HISTORY_TURNS],
    ).fetchall()
    history = list(reversed([dict(r) for r in hist_rows]))

    # (d) Answer using the shared whole-base helper (keyword fallback inside).
    try:
        answer, sources = answer_question_against_base(db, message, mode=mode, history=history)
    except Exception as exc:
        log.warning("kb_chat_generate_failed", error=str(exc)[:300])
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI generation failed — try again later",
        ) from exc

    # (h) Persist the assistant message (with sources + mode).
    assistant_id = str(uuid.uuid4())
    try:
        db.execute(
            """INSERT INTO tg_kb_chat_messages (id, role, content, sources, mode, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                assistant_id,
                "assistant",
                answer,
                json.dumps(sources, ensure_ascii=False) if sources else None,
                mode,
                _now(),
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("kb_chat_answered", mode=mode, sources=len(sources))

    # (i) Return the answer + cited sources + mode.
    return {"answer": answer, "sources": sources, "mode": mode}


@router.get("/chat/history")
async def kb_chat_history(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return the full chat history in chronological order."""
    rows = db.execute(
        """SELECT id, role, content, sources, mode, created_at
           FROM tg_kb_chat_messages
           ORDER BY created_at ASC""",
    ).fetchall()
    items = [_row_to_chat_message(dict(r)) for r in rows]
    return {"items": items, "total": len(items)}


@router.delete("/chat/history")
async def kb_chat_clear(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, int]:
    """Delete all chat history rows (start a fresh dialog)."""
    count_row = db.execute("SELECT COUNT(*) AS cnt FROM tg_kb_chat_messages").fetchone()
    deleted = count_row["cnt"] if count_row else 0

    try:
        db.execute("DELETE FROM tg_kb_chat_messages")
        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("kb_chat_cleared", deleted=deleted)
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Self-test (auto QA: generate control questions, answer them, judge coverage)
# ---------------------------------------------------------------------------


@router.post("/self-test", status_code=status.HTTP_202_ACCEPTED)
async def kb_self_test_start(
    _token: AdminAuth,
    db: WorkspaceDB,
    workspace_id: WorkspaceId,
) -> dict[str, str]:
    """Start a KB self-test run (Claude generates + answers + judges questions).

    Creates a PENDING run row and dispatches the ``pup_tg.kb_self_test`` Celery
    task. Dispatch failure flips the row to FAILED and returns 503 so we never
    leave a PENDING run no worker will pick up.
    """
    run_id = str(uuid.uuid4())

    db.execute(
        """INSERT INTO tg_kb_selftest_runs (id, status, created_at)
           VALUES (?, 'PENDING', ?)""",
        [run_id, _now()],
    )

    # Reuse the shared fail-fast dispatch; on failure flip the run to FAILED so
    # we never leave a PENDING run no worker will pick up.
    from app.tasks.dispatch import dispatch_task

    try:
        dispatch_task("pup_tg.kb_self_test", args=[workspace_id, run_id])
    except HTTPException:
        db.execute(
            """UPDATE tg_kb_selftest_runs
               SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?""",
            ["Dispatch failed: engine unavailable", _now(), run_id],
        )
        db.commit()
        log.warning("kb_self_test_dispatch_failed", run_id=run_id)
        raise

    db.commit()
    log.info("kb_self_test_dispatched", run_id=run_id, workspace_id=workspace_id)
    return {"run_id": run_id, "status": "PENDING"}


@router.get("/self-test/latest")
async def kb_self_test_latest(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return the most recent self-test run (results parsed from JSON)."""
    row = db.execute(
        """SELECT id, status, total, answered, gaps, results, summary, error,
                  created_at
           FROM tg_kb_selftest_runs
           ORDER BY created_at DESC LIMIT 1"""
    ).fetchone()

    if not row:
        return {
            "id": None,
            "status": "NONE",
            "total": 0,
            "answered": 0,
            "gaps": 0,
            "results": [],
            "summary": None,
            "error": None,
            "created_at": None,
        }

    data = dict(row)
    raw = data.get("results")
    if raw:
        try:
            data["results"] = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            data["results"] = []
    else:
        data["results"] = []
    return data


@router.get("/self-test/history")
async def kb_self_test_history(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> list[dict[str, Any]]:
    """List all self-test runs, most recent first (no heavy results payload)."""
    rows = db.execute(
        """SELECT id, status, total, answered, gaps, summary, created_at
           FROM tg_kb_selftest_runs
           ORDER BY created_at DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/self-test/{run_id}")
async def kb_self_test_detail(
    run_id: str,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Return one full self-test run (results parsed from JSON). 404 if absent."""
    row = db.execute(
        """SELECT id, status, total, answered, gaps, results, summary, error,
                  created_at
           FROM tg_kb_selftest_runs
           WHERE id = ?""",
        [run_id],
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Self-test run not found")

    data = dict(row)
    raw = data.get("results")
    if raw:
        try:
            data["results"] = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            data["results"] = []
    else:
        data["results"] = []
    return data
