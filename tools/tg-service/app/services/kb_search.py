"""Hybrid RAG retrieval (P6-01) — shared by /kb search/chat and the AI engines.

Combines keyword scoring with local vector cosine similarity over the
``tg_kb_chunks.embedding`` column. Behaviour by availability:

- **Embeddings available** + doc-scoped query → hybrid over the FULL doc pool
  (so semantically-relevant chunks that share no keywords are still found).
- **Embeddings available** + global query → keyword candidates re-ranked by
  vector (bounded — no full-KB scan).
- **Embeddings unavailable** → keyword-only, identical to the previous behaviour.

The single entry point is :func:`hybrid_retrieve`. ``search_chunk_texts`` is a
thin wrapper returning just the chunk texts (for the AI prompt builders).
"""

from __future__ import annotations

import re
from typing import Any

import structlog

log = structlog.get_logger(__name__)

_DOC_POOL_CAP = 1500  # max chunks scanned for a doc-scoped vector pass

_RICH_COLS = (
    "c.id, c.document_id, c.position, c.text, c.embedding, "
    "d.title AS document_title, d.metadata AS document_metadata"
)


def _words(query: str) -> list[str]:
    return [w.lower() for w in re.split(r"\s+", query.strip()) if len(w) >= 2]


def _keyword_candidates(
    db: Any, query: str, limit: int, doc_ids: list[str] | None
) -> list[dict[str, Any]]:
    """Keyword-matching chunks ranked by distinct hit count (legacy behaviour)."""
    words = _words(query)
    if not words:
        return []
    score_parts, where_parts, params = [], [], []
    for w in words:
        score_parts.append("(CASE WHEN LOWER(c.text) LIKE ? THEN 1 ELSE 0 END)")
        params.append(f"%{w}%")
    for w in words:
        where_parts.append("LOWER(c.text) LIKE ?")
        params.append(f"%{w}%")
    where = f"({' OR '.join(where_parts)})"
    if doc_ids:
        where += f" AND c.document_id IN ({', '.join('?' for _ in doc_ids)})"
        params.extend(doc_ids)
    sql = (
        f"SELECT {_RICH_COLS}, ({' + '.join(score_parts)}) AS kw_hits "
        f"FROM tg_kb_chunks c JOIN tg_kb_documents d ON d.id = c.document_id "
        f"WHERE {where} ORDER BY kw_hits DESC, c.position ASC LIMIT ?"
    )
    params.append(limit)
    return [dict(r) for r in db.execute(sql, params).fetchall()]


def _doc_pool(db: Any, doc_ids: list[str], cap: int) -> list[dict[str, Any]]:
    """All chunks in the given docs (capped) — the hybrid vector pool."""
    ph = ", ".join("?" for _ in doc_ids)
    sql = (
        f"SELECT {_RICH_COLS} FROM tg_kb_chunks c "
        f"JOIN tg_kb_documents d ON d.id = c.document_id "
        f"WHERE c.document_id IN ({ph}) ORDER BY c.position ASC LIMIT ?"
    )
    rows = [dict(r) for r in db.execute(sql, [*doc_ids, cap]).fetchall()]
    if len(rows) >= cap:
        log.info("kb_doc_pool_capped", cap=cap, doc_count=len(doc_ids))
    return rows


def hybrid_retrieve(
    db: Any,
    query: str,
    limit: int = 6,
    doc_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return up to *limit* chunk dicts ranked by hybrid keyword+vector score.

    Each returned dict carries ``id, document_id, position, text,
    document_title, document_metadata, score`` (the binary ``embedding`` is
    stripped). Never raises on embedding failure — falls back to keyword.
    """
    query = (query or "").strip()
    if not query:
        return []

    from app.ai import embeddings as emb

    qvec = None
    if emb.is_available():
        qvec = emb.blob_to_vector(emb.embed_text(query))

    if doc_ids and qvec is not None:
        rows = _doc_pool(db, doc_ids, _DOC_POOL_CAP)
        if not rows:  # docs have no chunks → nothing to find
            return []
    else:
        rows = _keyword_candidates(db, query, max(limit, 30), doc_ids)
        if not rows:
            return []

    words = _words(query)

    def kw_hits(text: str) -> int:
        t = text.lower()
        return sum(1 for w in words if w in t)

    max_kw = max((kw_hits(r["text"]) for r in rows), default=0) or 1

    scored: list[tuple[float, dict[str, Any]]] = []
    for r in rows:
        kw_norm = kw_hits(r["text"]) / max_kw
        if qvec is not None:
            cv = emb.blob_to_vector(r.get("embedding"))
            vec = max(0.0, emb.cosine(qvec, cv)) if cv is not None else 0.0
            score = 0.5 * vec + 0.5 * kw_norm
        else:
            score = kw_norm
        scored.append((score, r))

    scored.sort(key=lambda x: (-x[0], x[1]["position"]))
    out = [r for s, r in scored if s > 0][:limit]
    if not out:  # all-zero (e.g. vector-only pool, no keyword hit yet) → take top
        out = [r for _, r in scored][:limit]
    for r in out:
        r.pop("embedding", None)
        r.setdefault("score", None)
    return out


def search_chunk_texts(
    db: Any, doc_ids: list[str], query: str, limit: int = 3
) -> list[str]:
    """Thin wrapper for the AI prompt builders — returns just chunk texts."""
    if not doc_ids:
        return []
    rows = hybrid_retrieve(db, query, limit=limit, doc_ids=doc_ids)
    return [r["text"] for r in rows]
