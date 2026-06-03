"""Local text embeddings for hybrid RAG search (P6-01).

Uses **fastembed** (ONNX, runs locally — no external API, per CLAUDE.md). The
model is lazy-loaded once per process and cached. Everything degrades
gracefully: if fastembed or its model is unavailable (not installed, download
blocked, load error), the helpers return ``None`` / empty and callers fall back
to keyword-only search — so RAG never breaks.

Vectors are stored as little-endian float32 BLOBs in ``tg_kb_chunks.embedding``
(no numpy needed to read them back / score them).
"""

from __future__ import annotations

import os
import struct
import threading

import structlog

log = structlog.get_logger(__name__)

# Multilingual (RU+EN) small model — KB content is mostly Russian. 384-dim,
# ~0.22 GB, symmetric (no query/passage prefixes needed). Override via env.
_MODEL_NAME = os.getenv(
    "TG_EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
)
EMBED_DIM = 384

_model = None
_model_lock = threading.Lock()
_load_failed = False


def _get_model():
    """Lazily load the embedding model once. Returns None if unavailable."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    with _model_lock:
        if _model is not None or _load_failed:
            return _model
        try:
            from fastembed import TextEmbedding

            _model = TextEmbedding(model_name=_MODEL_NAME)
            log.info("embeddings_model_loaded", model=_MODEL_NAME)
        except Exception:  # noqa: BLE001 — missing lib / failed download / load
            _load_failed = True
            log.warning("embeddings_unavailable", model=_MODEL_NAME, exc_info=True)
    return _model


def is_available() -> bool:
    """True if the embedding model is loadable (so hybrid search is possible)."""
    return _get_model() is not None


def vector_to_blob(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def blob_to_vector(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    try:
        n = len(blob) // 4
        return list(struct.unpack(f"<{n}f", blob))
    except Exception:  # noqa: BLE001
        return None


def embed_text(text: str) -> bytes | None:
    """Embed one text → float32 BLOB, or None if unavailable/empty."""
    if not text or not text.strip():
        return None
    out = embed_batch([text])
    return out[0] if out else None


def embed_batch(texts: list[str]) -> list[bytes | None]:
    """Embed many texts → list of float32 BLOBs (None per failed/empty item)."""
    model = _get_model()
    if model is None:
        return [None] * len(texts)
    try:
        blobs: list[bytes | None] = []
        for vec in model.embed(list(texts)):
            blobs.append(vector_to_blob([float(x) for x in vec]))
        return blobs
    except Exception:  # noqa: BLE001
        log.warning("embed_batch_failed", exc_info=True)
        return [None] * len(texts)


def cosine(a: list[float] | None, b: list[float] | None) -> float:
    """Cosine similarity in [-1, 1]; 0.0 on missing/zero/mismatched vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
