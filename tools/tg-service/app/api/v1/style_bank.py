"""Style-bank: train the agent on REAL conversations (few-shot style learning).

Stores short, anonymized dialogue snippets the AI agent few-shots from to write
like a real person (tone / length / slang) — kept SEPARATE from RAG facts (which
are WHAT to say; this is HOW to say it). Sources: a commercially-licensed HF
dataset of informal Russian Telegram dialogues (Den4ikAI/russian_dialogues, MIT),
scraped chats, or pasted text.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.deps import AdminAuth, WorkspaceDB, WorkspaceId

router = APIRouter(prefix="/style", tags=["style-bank"])
log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Cleaning / anonymization
# ---------------------------------------------------------------------------

_RE_URL = re.compile(r"https?://\S+|t\.me/\S+|www\.\S+", re.I)
_RE_MENTION = re.compile(r"@\w+")
_RE_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_RE_PHONE = re.compile(r"(?<!\w)(?:\+?\d[\d\-\s()]{7,}\d)(?!\w)")
_RE_WS = re.compile(r"\s+")
_RE_HAS_LETTER = re.compile(r"[а-яёa-z]", re.I)


def clean_text(t: str) -> str:
    """Strip PII (links, @handles, emails, phones), collapse whitespace."""
    if not t:
        return ""
    t = _RE_URL.sub("", t)
    t = _RE_MENTION.sub("", t)
    t = _RE_EMAIL.sub("", t)
    t = _RE_PHONE.sub("", t)
    t = _RE_WS.sub(" ", t).strip()
    return t


def is_good_line(t: str, *, min_len: int = 2, max_len: int = 200) -> bool:
    """Keep only short, real, letter-bearing chat lines (not junk/links/spam)."""
    if not t or not (min_len <= len(t) <= max_len):
        return False
    if not _RE_HAS_LETTER.search(t):
        return False
    # Drop obvious bot/command/forward noise.
    low = t.lower()
    if low.startswith("/") or "forwarded" in low or "переслано" in low:
        return False
    return True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Import from Hugging Face (Den4ikAI/russian_dialogues — MIT, RU TG dialogues)
# ---------------------------------------------------------------------------

_HF_DATASET = "Den4ikAI/russian_dialogues"
_HF_TOTAL = 2_477_321  # rows; used to spread random sampling across the corpus
_HF_ROWS_URL = "https://datasets-server.huggingface.co/rows"


def import_hf_dialogues(db: Any, target: int = 2000, topic: str = "общее") -> dict[str, Any]:
    """Fetch ~target relevant Q→A pairs from the HF dataset and store as snippets.

    Samples from RANDOM offsets across the 2.48M-row corpus for variety, keeps
    only relevance=1 pairs that survive cleaning, dedups, and stores each as a
    2-turn anonymized dialogue snippet. Synchronous (httpx.Client) so it runs
    from a Celery task or a one-off script. Returns counts.
    """
    import random

    target = max(1, min(int(target), 20000))
    imported = 0
    scanned = 0
    seen: set[tuple[str, str]] = set()
    errors = 0

    with httpx.Client(timeout=30.0) as client:
        # Bound the number of page fetches so a degraded API can't loop forever.
        max_pages = target // 20 + 60
        for _ in range(max_pages):
            if imported >= target:
                break
            offset = random.randint(0, max(0, _HF_TOTAL - 100))
            try:
                resp = client.get(
                    _HF_ROWS_URL,
                    params={
                        "dataset": _HF_DATASET,
                        "config": "default",
                        "split": "train",
                        "offset": offset,
                        "length": 100,
                    },
                )
                if resp.status_code != 200:
                    errors += 1
                    if errors > 8:
                        break
                    continue
                rows = resp.json().get("rows", [])
            except Exception:  # noqa: BLE001
                errors += 1
                if errors > 8:
                    break
                continue

            for rr in rows:
                scanned += 1
                row = rr.get("row", {})
                if row.get("relevance") != 1:
                    continue
                q = clean_text(row.get("question", ""))
                a = clean_text(row.get("answer", ""))
                if not is_good_line(q) or not is_good_line(a):
                    continue
                key = (q[:40].lower(), a[:40].lower())
                if key in seen:
                    continue
                seen.add(key)
                snippet = json.dumps(
                    [{"a": "Собеседник1", "t": q}, {"a": "Собеседник2", "t": a}],
                    ensure_ascii=False,
                )
                try:
                    db.execute(
                        "INSERT INTO tg_style_samples "
                        "(id, source, lang, topic, snippet, quality, created_at) "
                        "VALUES (?, 'hf', 'ru', ?, ?, 1.0, ?)",
                        [str(uuid.uuid4()), topic, snippet, _now()],
                    )
                    imported += 1
                except Exception:  # noqa: BLE001
                    pass
                if imported >= target:
                    break
            db.commit()

    log.info("style_hf_import", imported=imported, scanned=scanned, topic=topic)
    return {"imported": imported, "scanned": scanned, "topic": topic}


# ---------------------------------------------------------------------------
# Scrape a real chat into the style bank (on-topic live style)
# ---------------------------------------------------------------------------


def _norm_chat(chat: str) -> str:
    s = (chat or "").strip()
    for pre in ("https://t.me/", "http://t.me/", "t.me/", "@"):
        if s.startswith(pre):
            return s[len(pre):]
    return s


async def scrape_chat_to_style(
    workspace_id: str, account_id: str, chat: str, topic: str = "крипта", limit: int = 400
) -> dict[str, Any]:
    """Read a real chat via an account and store consecutive reply pairs as
    on-topic style snippets. Anonymizes senders, cleans PII, dedups.

    The account must be able to resolve the chat (member of it, or it's public).
    Best for niche chats (crypto/income) so the agent learns the ACTUAL on-topic
    style. Runs from a Celery task (connects to Telegram via the account proxy).
    """
    from app.core.database import get_db
    from app.telegram.client_pool import disconnect_client, get_client_for_account

    db = get_db(workspace_id)
    client = None
    imported = 0
    scanned = 0
    try:
        client = await get_client_for_account(account_id, db)
        entity = await client.get_entity(_norm_chat(chat))
        chat_title = getattr(entity, "title", chat) or chat

        msgs: list[tuple[Any, str]] = []
        async for m in client.iter_messages(entity, limit=max(50, min(limit, 2000))):
            if m.text:
                msgs.append((m.sender_id, clean_text(m.text)))
        msgs.reverse()  # chronological
        scanned = len(msgs)

        seen: set[tuple[str, str]] = set()
        i = 0
        while i < len(msgs) - 1:
            (s1, t1), (s2, t2) = msgs[i], msgs[i + 1]
            # A reply pair = two consecutive messages from DIFFERENT senders,
            # both real chat lines. That captures how people actually respond.
            if s1 != s2 and is_good_line(t1) and is_good_line(t2):
                key = (t1[:40].lower(), t2[:40].lower())
                if key not in seen:
                    seen.add(key)
                    snippet = json.dumps(
                        [{"a": "Собеседник1", "t": t1}, {"a": "Собеседник2", "t": t2}],
                        ensure_ascii=False,
                    )
                    try:
                        db.execute(
                            "INSERT INTO tg_style_samples "
                            "(id, source, lang, topic, snippet, quality, created_at) "
                            "VALUES (?, 'scrape', 'ru', ?, ?, 1.0, ?)",
                            [str(uuid.uuid4()), topic, snippet, _now()],
                        )
                        imported += 1
                    except Exception:  # noqa: BLE001
                        pass
                i += 2
            else:
                i += 1
        db.commit()
        log.info("style_scrape_done", chat=chat_title, imported=imported, scanned=scanned, topic=topic)
        return {"imported": imported, "scanned": scanned, "topic": topic, "chat_title": chat_title}
    finally:
        await disconnect_client(client)


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------


class ImportHfRequest(BaseModel):
    count: int = Field(default=2000, ge=50, le=20000)
    topic: str = "общее"


class PasteRequest(BaseModel):
    text: str
    topic: str = "общее"


class ScrapeChatRequest(BaseModel):
    chat: str
    account_id: str
    topic: str = "крипта"
    limit: int = Field(default=400, ge=50, le=2000)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/stats")
async def style_stats(_token: AdminAuth, db: WorkspaceDB) -> dict[str, Any]:
    """Counts per topic + total — for the UI."""
    total = db.execute("SELECT COUNT(*) AS c FROM tg_style_samples").fetchone()["c"]
    by_topic = [
        {"topic": r["topic"], "count": r["c"]}
        for r in db.execute(
            "SELECT topic, COUNT(*) AS c FROM tg_style_samples GROUP BY topic ORDER BY c DESC"
        ).fetchall()
    ]
    return {"total": total, "by_topic": by_topic}


@router.get("/samples")
async def style_samples(
    _token: AdminAuth,
    db: WorkspaceDB,
    topic: str | None = Query(None),
    limit: int = Query(30, ge=1, le=200),
) -> dict[str, Any]:
    """Preview stored snippets (for review/cleanup in the UI)."""
    if topic:
        rows = db.execute(
            "SELECT id, source, topic, snippet, created_at FROM tg_style_samples "
            "WHERE topic = ? ORDER BY created_at DESC LIMIT ?",
            [topic, limit],
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, source, topic, snippet, created_at FROM tg_style_samples "
            "ORDER BY created_at DESC LIMIT ?",
            [limit],
        ).fetchall()
    items = []
    for r in rows:
        try:
            snip = json.loads(r["snippet"])
        except (ValueError, TypeError):
            snip = []
        items.append({
            "id": r["id"], "source": r["source"], "topic": r["topic"],
            "snippet": snip, "created_at": r["created_at"],
        })
    return {"items": items}


@router.post("/import-hf")
async def style_import_hf(
    body: ImportHfRequest,
    _token: AdminAuth,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Dispatch a background import of N informal-RU dialogue snippets from HF."""
    try:
        from app.tasks.celery_app import celery_app
        celery_app.send_task(
            "pup_tg.style_import_hf",
            args=[workspace_id, body.count, body.topic],
            queue="pup_tg_default",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Не удалось запустить импорт: {exc}",
        ) from exc
    return {"success": True, "message": f"Импорт {body.count} примеров запущен (тема: {body.topic})"}


@router.post("/scrape-chat")
async def style_scrape_chat(
    body: ScrapeChatRequest,
    _token: AdminAuth,
    workspace_id: WorkspaceId,
) -> dict[str, Any]:
    """Dispatch a background scrape of a real chat into on-topic style snippets."""
    try:
        from app.tasks.celery_app import celery_app
        celery_app.send_task(
            "pup_tg.style_scrape_chat",
            args=[workspace_id, body.account_id, body.chat, body.topic, body.limit],
            queue="pup_tg_default",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Не удалось запустить скрейп: {exc}",
        ) from exc
    return {"success": True, "message": f"Скрейп чата запущен (тема: {body.topic}). Аккаунт должен быть участником чата."}


@router.post("/paste")
async def style_paste(
    body: PasteRequest,
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Ingest a pasted conversation: one message per line → 2-turn snippets."""
    lines = [clean_text(ln) for ln in (body.text or "").splitlines()]
    lines = [ln for ln in lines if is_good_line(ln)]
    if len(lines) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Нужно минимум 2 осмысленные строки (по сообщению на строку)",
        )
    imported = 0
    now = _now()
    for i in range(len(lines) - 1):
        snippet = json.dumps(
            [{"a": "Собеседник1", "t": lines[i]}, {"a": "Собеседник2", "t": lines[i + 1]}],
            ensure_ascii=False,
        )
        try:
            db.execute(
                "INSERT INTO tg_style_samples "
                "(id, source, lang, topic, snippet, quality, created_at) "
                "VALUES (?, 'paste', 'ru', ?, ?, 1.0, ?)",
                [str(uuid.uuid4()), body.topic, snippet, now],
            )
            imported += 1
        except Exception:  # noqa: BLE001
            pass
    db.commit()
    return {"success": True, "imported": imported, "topic": body.topic}


@router.delete("/clear")
async def style_clear(
    _token: AdminAuth,
    db: WorkspaceDB,
    topic: str | None = Query(None),
) -> dict[str, Any]:
    """Delete all snippets (or just one topic)."""
    if topic:
        cur = db.execute("DELETE FROM tg_style_samples WHERE topic = ?", [topic])
    else:
        cur = db.execute("DELETE FROM tg_style_samples")
    db.commit()
    return {"success": True, "deleted": cur.rowcount}
