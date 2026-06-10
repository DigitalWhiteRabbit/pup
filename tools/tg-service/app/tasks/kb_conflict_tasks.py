"""Celery task: Knowledge Base consistency check.

After a document is added (or after a crawl finishes) this task compares
documents against each other with Claude and stores any detected DUPLICATES
or CONTRADICTIONS in ``tg_kb_conflicts`` for the user to resolve.

Two modes, selected by ``doc_id``:

* ``doc_id`` given  → the "new" document is compared against ALL OTHER docs.
* ``doc_id`` None   → the WHOLE base is checked (all docs given to Claude at
  once) — used after a crawl that added many pages.

The task is deliberately bounded (truncated content, a cap on how many docs
go into one prompt) to control token cost, and is tolerant of every failure
mode (missing API key, malformed JSON, DB errors) — it logs and returns
instead of crashing the worker.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

import structlog

from app.ai.anthropic_client import generate_message
from app.core.database import get_db
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# ── Model alias resolution (same pattern as the other AI tasks) ──────────────
_MODEL_ALIASES: dict[str, str] = {
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6": "claude-sonnet-4-6-20260514",
    "claude-opus-4-6": "claude-opus-4-6-20260514",
}


def _resolve_model(name: str | None) -> str:
    """Turn a short alias into a full Anthropic model ID (default Haiku)."""
    if not name:
        return "claude-haiku-4-5-20251001"
    return _MODEL_ALIASES.get(name, name)


# ── Bounds (keep token cost predictable) ─────────────────────────────────────
CONTENT_TRUNCATE = 2000  # chars per document fed to Claude
MAX_OTHER_DOCS = 25  # cap on how many existing docs go into one prompt
MAX_OUTPUT_TOKENS = 2048


_SYSTEM_PROMPT = (
    "Ты — аудитор базы знаний. Тебе дают НОВЫЙ документ и список СУЩЕСТВУЮЩИХ "
    "документов (каждый с id, заголовком и фрагментом текста). Твоя задача — "
    "найти КОНФЛИКТЫ между новым документом и существующими:\n"
    "- 'duplicate' (дубликат): новый документ содержит ту же информацию, что уже "
    "есть в существующем документе.\n"
    "- 'contradiction' (противоречие): факты конфликтуют (разные цены, даты, "
    "числа, условия, взаимоисключающие утверждения).\n\n"
    "Верни СТРОГО валидный JSON — массив объектов, без markdown, без пояснений. "
    "Каждый объект:\n"
    '{"type": "duplicate"|"contradiction", "doc_a_id": "<id нового>", '
    '"doc_b_id": "<id существующего>", "summary": "<краткое описание на русском>", '
    '"quote_a": "<точная цитата из нового>", "quote_b": "<точная цитата из '
    'существующего>", "field": "<для contradiction: короткое название того, что '
    'различается, на русском, напр. \\"Дата запуска\\", \\"Тариф\\"; для '
    'duplicate — null>", "value_a": "<для contradiction: значение из нового '
    'документа; для duplicate — null>", "value_b": "<для contradiction: значение '
    'из существующего документа; для duplicate — null>"}\n\n'
    "Для 'contradiction' ОБЯЗАТЕЛЬНО заполни field/value_a/value_b конкретными "
    "различающимися значениями. Для 'duplicate' оставь field/value_a/value_b "
    "равными null.\n\n"
    "Если конфликтов нет — верни пустой массив []. Не выдумывай конфликты; "
    "сообщай только о реальных совпадениях или противоречиях."
)


def _truncate(text: str | None, limit: int = CONTENT_TRUNCATE) -> str:
    """Return *text* trimmed to *limit* chars (empty string if None)."""
    if not text:
        return ""
    text = text.strip()
    return text[:limit]


def _opt_field(value: Any, limit: int = 500) -> str | None:
    """Coerce a structured contradiction field to a trimmed str, or None.

    Returns None for missing/empty values so 'duplicate' conflicts (and any
    contradiction Claude leaves blank) persist NULL rather than empty strings.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    return text[:limit]


def _keyword_overlap(a: str, b: str) -> int:
    """Count shared lowercase words (>=4 chars) between two strings."""
    wa = {w for w in re.findall(r"\w{4,}", (a or "").lower())}
    wb = {w for w in re.findall(r"\w{4,}", (b or "").lower())}
    return len(wa & wb)


def _load_docs(db: Any) -> list[dict[str, Any]]:
    """Load all KB documents (id, title, content)."""
    rows = db.execute(
        "SELECT id, title, content FROM tg_kb_documents ORDER BY created_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def _parse_conflicts(raw: str) -> list[dict[str, Any]]:
    """Tolerantly parse Claude's JSON array of conflicts.

    Strips markdown fences and extracts the first JSON array if there is any
    surrounding prose. Returns [] on any failure.
    """
    if not raw:
        return []
    text = raw.strip()
    # Strip ```json ... ``` fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        # Fall back to the first [...] block in the response.
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return []
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            return []
    if not isinstance(parsed, list):
        return []
    return [c for c in parsed if isinstance(c, dict)]


def _conflict_exists(
    db: Any, doc_a_id: str | None, doc_b_id: str | None, conflict_type: str
) -> bool:
    """True if a conflict already exists for this (a, b, type) pair, ANY status.

    Matches open, resolved AND dismissed rows so once the user has dealt with a
    pair (Оставить оба → resolved, Пропустить → dismissed) a re-check ("Проверить
    базу") never resurfaces it. Checks both orderings of the doc pair so we don't
    double-record A↔B. Deleted/merged docs no longer match (their ids are gone).
    """
    row = db.execute(
        """SELECT 1 FROM tg_kb_conflicts
           WHERE conflict_type = ?
             AND (
                  (doc_a_id = ? AND doc_b_id = ?)
               OR (doc_a_id = ? AND doc_b_id = ?)
             )
           LIMIT 1""",
        [conflict_type, doc_a_id, doc_b_id, doc_b_id, doc_a_id],
    ).fetchone()
    return row is not None


def _store_conflicts(
    db: Any,
    conflicts: list[dict[str, Any]],
    titles: dict[str, str],
) -> int:
    """Insert detected conflicts (deduping handled pairs). Returns inserted count."""
    inserted = 0
    for c in conflicts:
        ctype = str(c.get("type") or "").strip().lower()
        if ctype not in ("duplicate", "contradiction"):
            continue
        doc_a_id = c.get("doc_a_id")
        doc_b_id = c.get("doc_b_id")
        if not doc_a_id or not doc_b_id or doc_a_id == doc_b_id:
            continue
        if _conflict_exists(db, doc_a_id, doc_b_id, ctype):
            continue
        # Structured contradiction fields: only meaningful for contradictions;
        # duplicates persist NULL (the prompt asks Claude to return null too).
        if ctype == "contradiction":
            conflict_field = _opt_field(c.get("field"))
            value_a = _opt_field(c.get("value_a"))
            value_b = _opt_field(c.get("value_b"))
        else:
            conflict_field = value_a = value_b = None
        db.execute(
            """INSERT INTO tg_kb_conflicts
                (id, conflict_type, doc_a_id, doc_a_title, doc_b_id, doc_b_title,
                 summary, quote_a, quote_b, conflict_field, value_a, value_b,
                 status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))""",
            [
                str(uuid.uuid4()),
                ctype,
                doc_a_id,
                titles.get(doc_a_id, ""),
                doc_b_id,
                titles.get(doc_b_id, ""),
                _truncate(c.get("summary"), 1000),
                _truncate(c.get("quote_a"), 1000),
                _truncate(c.get("quote_b"), 1000),
                conflict_field,
                value_a,
                value_b,
            ],
        )
        inserted += 1
    if inserted:
        db.commit()
    return inserted


def _build_user_message(
    new_doc: dict[str, Any] | None, others: list[dict[str, Any]]
) -> str:
    """Assemble the user message: new doc + existing docs (truncated)."""
    parts: list[str] = []
    if new_doc is not None:
        parts.append(
            "НОВЫЙ ДОКУМЕНТ:\n"
            f"id: {new_doc['id']}\n"
            f"title: {new_doc.get('title', '')}\n"
            f"text: {_truncate(new_doc.get('content'))}\n"
        )
    parts.append("СУЩЕСТВУЮЩИЕ ДОКУМЕНТЫ:")
    for d in others:
        parts.append(
            f"---\nid: {d['id']}\n"
            f"title: {d.get('title', '')}\n"
            f"text: {_truncate(d.get('content'))}"
        )
    return "\n".join(parts)


@celery_app.task(name="pup_tg.kb_check_conflicts", bind=True, max_retries=0)
def kb_check_conflicts(
    self, workspace_id: str, doc_id: str | None = None
) -> dict[str, Any]:  # type: ignore[override]
    """Compare KB documents with Claude and store duplicates/contradictions.

    * ``doc_id`` given → compare that doc against all others.
    * ``doc_id`` None  → check the whole base at once.

    Bounded and fully tolerant: any error is logged and returned as a status.
    """
    log.info(
        "kb_conflict_task_started",
        workspace_id=workspace_id,
        doc_id=doc_id,
        celery_task_id=self.request.id,
    )

    try:
        db = get_db(workspace_id)
        docs = _load_docs(db)
    except Exception as exc:  # noqa: BLE001
        log.error("kb_conflict_load_failed", workspace_id=workspace_id, error=str(exc))
        return {"status": "FAILED", "error": str(exc)[:300]}

    if len(docs) < 2:
        log.info("kb_conflict_skip_too_few", workspace_id=workspace_id, docs=len(docs))
        return {"status": "DONE", "conflicts_found": 0, "reason": "fewer than 2 docs"}

    titles = {d["id"]: d.get("title", "") for d in docs}

    # Build the doc set to compare.
    if doc_id:
        new_doc = next((d for d in docs if d["id"] == doc_id), None)
        if new_doc is None:
            log.warning("kb_conflict_doc_missing", workspace_id=workspace_id, doc_id=doc_id)
            return {"status": "DONE", "conflicts_found": 0, "reason": "doc not found"}
        others = [d for d in docs if d["id"] != doc_id]
        # If the base is large, prioritise the most keyword-relevant docs.
        if len(others) > MAX_OTHER_DOCS:
            others.sort(
                key=lambda d: _keyword_overlap(
                    new_doc.get("content", ""), d.get("content", "")
                ),
                reverse=True,
            )
            others = others[:MAX_OTHER_DOCS]
        user_message = _build_user_message(new_doc, others)
    else:
        # Whole-base check: cap the number of docs fed to one prompt.
        subset = docs[:MAX_OTHER_DOCS]
        user_message = _build_user_message(None, subset)

    try:
        result = generate_message(
            system_prompt=_SYSTEM_PROMPT,
            user_message=user_message,
            model=_resolve_model("claude-haiku-4-5"),
            max_tokens=MAX_OUTPUT_TOKENS,
            temperature=0.2,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("kb_conflict_claude_failed", workspace_id=workspace_id, error=str(exc))
        return {"status": "FAILED", "error": str(exc)[:300]}

    conflicts = _parse_conflicts(result.get("text", ""))
    log.info(
        "kb_conflict_claude_parsed",
        workspace_id=workspace_id,
        parsed=len(conflicts),
        cost_usd=result.get("cost_usd"),
    )

    try:
        inserted = _store_conflicts(db, conflicts, titles)
    except Exception as exc:  # noqa: BLE001
        log.error("kb_conflict_store_failed", workspace_id=workspace_id, error=str(exc))
        return {"status": "FAILED", "error": str(exc)[:300]}

    log.info(
        "kb_conflict_task_done",
        workspace_id=workspace_id,
        doc_id=doc_id,
        conflicts_found=inserted,
    )
    return {"status": "DONE", "conflicts_found": inserted, "parsed": len(conflicts)}
