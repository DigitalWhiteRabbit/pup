"""Celery task for the unified AI Agent — chat engagement + DM outreach.

Replaces the separate AI Promoter and AI Sales workers with ONE agent
that works both in group chats AND direct messages.

The agent is a "persona" linked to multiple Telegram accounts.  It:
1. Joins target chats (already joined by user via separate action)
2. Reads last N messages + chat description to understand context
3. Engages in conversations naturally — asks questions, comments
4. If someone shows interest (score >= 7) -> initiates DM
5. In DM — tells about the project using Knowledge Base (RAG)
6. Goal: convert cold leads from chats into deals via DMs

Anti-ban: random delays 60-300s between chat replies, 30-120s between
DMs, active hours enforcement, daily message caps, FloodWait / PeerFlood
/ ChatWriteForbidden / ChannelPrivate / AuthKeyUnregistered handling.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import shutil
import tempfile
import uuid
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

import structlog

from app.config import settings
from app.core.database import get_db
from app.core.notify import notify_admin_pref
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# ── Terminal lead statuses (no further DM outreach for these) ──────────────
_TERMINAL_STATUSES = {"CONVERTED", "LOST", "HANDED_OFF"}

# ── Model name normalisation ──────────────────────────────────────────────
_MODEL_ALIASES: dict[str, str] = {
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6": "claude-sonnet-4-6-20260514",
    "claude-opus-4-6": "claude-opus-4-6-20260514",
}


def _resolve_model(name: str | None) -> str:
    """Turn a short alias into a full Anthropic model ID."""
    if not name:
        return "claude-haiku-4-5-20251001"
    return _MODEL_ALIASES.get(name, name)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_activity(
    db: Any,
    persona_id: str,
    chat_id: Any,
    chat_title: str | None,
    kind: str,
    message: str,
    meta: dict | None = None,
) -> None:
    """Best-effort: record one agent action for the per-chat activity feed.

    Powers the operator's "agent monitor" — a live, human-readable log of what
    the agent did (scan/read/skip/think/sent/sleep/kb). Failures are swallowed:
    activity logging must never break an agent cycle. Persona-level events
    (no specific chat) pass ``chat_id=None``.
    """
    try:
        import uuid as _uuid
        db.execute(
            "INSERT INTO tg_ai_activity "
            "(id, persona_id, chat_id, chat_title, kind, message, meta, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                str(_uuid.uuid4()), persona_id,
                str(chat_id) if chat_id is not None else None,
                chat_title, kind, message,
                json.dumps(meta, ensure_ascii=False) if meta else None, _now(),
            ],
        )
        db.commit()
    except Exception:
        log.debug("ai_activity_log_failed", persona_id=persona_id, exc_info=True)


# ══════════════════════════════════════════════════════════════════════════
# Human-behaviour helpers (make the agent feel like a real person)
# ══════════════════════════════════════════════════════════════════════════

_REACTION_SET = ["👍", "❤️", "🔥", "😁", "😢", "🤔", "👏", "🙏", "💯", "😎", "🤣", "👌"]


def _humanize_text(t: str) -> str:
    """Strip robotic tells so the reply doesn't read like AI.

    #1 giveaway = the em/en dash (—, –). Humans rarely type it. Also normalise
    fancy quotes/ellipsis and trim assistant-y leading filler.
    """
    if not t:
        return t
    # Long dashes → comma+space (natural in RU), then collapse artefacts.
    t = t.replace(" — ", ", ").replace(" – ", ", ").replace("—", ", ").replace("–", "-").replace("―", "-")
    t = t.replace("…", "...")
    t = t.replace("“", '"').replace("”", '"').replace("„", '"').replace("‘", "'").replace("’", "'")
    # robotic openers
    for junk in ("Конечно! ", "Конечно, ", "Разумеется, ", "Безусловно, ", "Как ИИ", "Как языковая модель"):
        if t.startswith(junk):
            t = t[len(junk):]
    while ", ," in t:
        t = t.replace(", ,", ",")
    while "  " in t:
        t = t.replace("  ", " ")
    return t.strip().strip(",").strip()


def _is_directed(msg: Any, own_username: str | None, our_msg_ids: set) -> bool:
    """True if the message is aimed at us — a reply to our message or an @mention."""
    try:
        rt = getattr(msg, "reply_to", None)
        if rt and getattr(rt, "reply_to_msg_id", None) in our_msg_ids:
            return True
        if own_username and ("@" + own_username) in (msg.text or "").lower():
            return True
    except Exception:
        pass
    return False


async def _pick_reaction(text: str, model: str) -> str | None:
    """Ask Claude to pick ONE emoji reaction a human would naturally tap (or None).

    Meaningful, not random — reads the message and reacts in context. Cheap call.
    """
    try:
        from app.ai.anthropic_client import generate_message
        res = generate_message(
            system_prompt=(
                "Ты живой участник чата. Тебе дают сообщение. Выбери ОДНУ реакцию-эмодзи, "
                "которую естественно поставил бы человек по смыслу, строго из списка: "
                + " ".join(_REACTION_SET) +
                ". Если реакция неуместна — ответь NONE. Ответ: только один эмодзи или NONE."
            ),
            user_message=text[:500],
            model=model, max_tokens=8, temperature=0.7,
        )
        out = (res.get("text") or "").strip()
        for e in _REACTION_SET:
            if e in out:
                return e
    except Exception:
        pass
    return None


async def _should_engage(recent_context: list, persona: dict, model: str) -> tuple[bool, str]:
    """Brain: decide whether to JUMP INTO the conversation right now.

    A real person doesn't answer every message — they chime in only when the
    topic is theirs, when they can naturally add something, or (for our agent)
    when it's a chance to organically bring up their interest/knowledge. Returns
    (engage, short_reason). Cheap Claude call. Default to NOT engaging on error.
    """
    try:
        from app.ai.anthropic_client import generate_message
        ctx = "\n".join(recent_context[-12:]) if recent_context else ""
        niche = persona.get("niche") or "крипта, пассивный доход"
        res = generate_message(
            system_prompt=(
                "Ты — обычный дружелюбный участник этого чата (живой человек, не "
                "бот и не эксперт-консультант). Веди себя как нормальный человек в "
                "компании: поддерживай живую беседу. Твои личные интересы: " + niche + ". "
                "Реши, ответил бы ЖИВОЙ участник на последнее сообщение прямо сейчас. "
                "Отвечай YES, если выполнено хотя бы одно: (1) это вопрос или "
                "предложение группе (например «кто хочет…?», «идём?», «как дела?»); "
                "(2) идёт живой разговор, куда уместно вставить слово, согласиться, "
                "пошутить, поддержать; (3) тема тебе интересна или ты можешь по делу "
                "что-то добавить; (4) можно органично подтянуть свою тему. "
                "Отвечай NO ТОЛЬКО если: это явный спам/реклама, бессмысленный набор "
                "символов или стикер без текста, или сообщение совсем не ждёт ответа и "
                "добавить реально нечего. В обычной дружеской болтовне ЧАЩЕ отвечай, "
                "чем молчи — молчать стоит лишь иногда. "
                "Ответь строго одним словом: YES или NO."
            ),
            user_message="Последние сообщения чата:\n" + ctx + "\n\nОтветил бы живой человек сейчас? YES/NO",
            model=model, max_tokens=4, temperature=0.4,
        )
        out = (res.get("text") or "").strip().upper()
        return (out.startswith("Y"), out[:10])
    except Exception:
        return (False, "err")


async def _generate_opener(
    persona: dict,
    chat_title: str,
    chat_about: str,
    recent_context: list,
    model: str,
    temperature: float,
    own_name: str | None = None,
    own_username: str | None = None,
) -> tuple[str | None, float]:
    """Generate a natural, on-topic opener to revive a quiet chat.

    Used by the proactive-initiation branch when a chat has gone silent. The
    opener blends in (a question / opinion / observation about the chat's own
    topic) — NOT an ad — so it reads like a regular member breaking the silence.
    Returns (humanized_text, cost_usd); (None, 0) on failure or empty output.
    """
    try:
        from app.ai.anthropic_client import generate_message

        niche = persona.get("niche") or "крипта, пассивный доход"
        ctx = "\n".join(recent_context[-10:]) if recent_context else "(история старая/пустая)"
        topic = []
        if chat_title:
            topic.append(f"Чат: {chat_title}")
        if chat_about:
            topic.append(f"Описание чата: {chat_about[:300]}")
        topic_str = "\n".join(topic) if topic else f"Тема близкая к: {niche}"

        sys = (
            "Ты живой участник Telegram-чата. В чате давно тишина, и ты решил её "
            "естественно оживить. Напиши ОДНО короткое сообщение по теме этого "
            "чата: уместный вопрос, мнение или наблюдение, на которое людям "
            "захочется ответить. Строго по-русски, 1-2 предложения, разговорно. "
            "ЗАПРЕЩЕНО: длинные тире (—), приветствия-штампы («Всем привет», «Друзья»), "
            "реклама/ссылки, списки, канцелярит. Пиши как обычный человек, без намёка "
            "на бота. Верни ТОЛЬКО текст сообщения."
            + _build_identity_block(own_name, own_username)
        )
        user = (
            f"{topic_str}\n\nПоследние сообщения (могут быть старыми):\n{ctx}\n\n"
            "Напиши одно живое сообщение, чтобы оживить беседу по теме чата."
        )
        res = generate_message(
            system_prompt=sys, user_message=user, model=model,
            max_tokens=160, temperature=max(temperature, 0.9),
        )
        text = _humanize_text((res.get("text") or "").strip())
        return (text or None, float(res.get("cost_usd") or 0.0))
    except Exception:
        log.warning("ai_agent_opener_failed", exc_info=True)
        return (None, 0.0)


async def _send_reaction(client: Any, entity: Any, msg_id: int, emoji: str) -> bool:
    """Put an emoji reaction on a message (like a human tapping a reaction)."""
    try:
        from telethon.tl.functions.messages import SendReactionRequest
        from telethon.tl.types import ReactionEmoji
        await client(SendReactionRequest(
            peer=entity, msg_id=msg_id, reaction=[ReactionEmoji(emoticon=emoji)],
        ))
        return True
    except Exception as exc:
        log.debug("ai_agent_reaction_failed", error=str(exc)[:120])
        return False


async def _human_pause(client: Any, entity: Any, delay: float) -> None:
    """Wait a human-like delay while KEEPING THE PROXY CONNECTION WARM.

    Delay is capped (<=120s) so the cycle stays short and the loop stays robust.
    Crucially, we send a lightweight 'typing…' action every few seconds for the
    WHOLE wait (not just the end): residential proxies drop idle TCP, so a long
    silent sleep is exactly what makes the subsequent send fail. Periodic traffic
    keeps the connection alive AND doubles as a natural "typing" indicator.
    """
    delay = max(2.0, min(float(delay), 120.0))
    try:
        from telethon.tl.functions.messages import SetTypingRequest
        from telethon.tl.types import SendMessageCancelAction, SendMessageTypingAction
        # "Thinking" head: shorter idle (people don't type instantly), but still
        # ping the connection so it doesn't go stale. The visible "typing" runs
        # for the tail. Either way we never idle longer than ~6s at a stretch.
        think = max(0.0, delay - min(delay, 15.0))
        elapsed = 0.0
        while elapsed < delay:
            in_typing_tail = elapsed >= think
            try:
                action = (
                    SendMessageTypingAction() if in_typing_tail
                    else SendMessageCancelAction()
                )
                await client(SetTypingRequest(peer=entity, action=action))
            except Exception:
                pass  # keep-alive is best-effort; do not break the pause
            step = min(6.0, delay - elapsed)
            await asyncio.sleep(step)
            elapsed += step
    except Exception:
        await asyncio.sleep(min(delay, 10.0))


async def _resilient_send(
    client: Any, entity: Any, text: str, reply_to: int | None = None, attempts: int = 4
) -> Any:
    """Send a message, retrying through transient proxy/connection drops.

    Residential proxies flap — a single ``send_message`` often fails because the
    (idle) connection just dropped, even though the gateway is up again a second
    later. We retry a few times with backoff, reconnecting between attempts, to
    catch a good window. Ban / write-forbidden / flood errors are NOT transient,
    so they are re-raised immediately for the caller's dedicated handlers
    (auto-pause, PENDING-on-flood, etc.). Raises the last error if all fail.
    """
    from telethon.errors import (
        ChatWriteForbiddenError,
        FloodWaitError,
        PeerFloodError,
        UserBannedInChannelError,
    )

    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            try:
                if not client.is_connected():
                    await client.connect()
            except Exception:
                pass
            return await client.send_message(entity, text, reply_to=reply_to)
        except (UserBannedInChannelError, ChatWriteForbiddenError, FloodWaitError, PeerFloodError):
            raise  # not transient — let the caller handle it
        except Exception as e:  # noqa: BLE001
            last_exc = e
            log.warning("resilient_send_retry", attempt=i + 1, attempts=attempts, error=str(e)[:90])
            if i < attempts - 1:
                await asyncio.sleep(2.0 * (i + 1))  # 2s, 4s, 6s backoff
    if last_exc:
        raise last_exc
    return None


# ══════════════════════════════════════════════════════════════════════════
# Schedule helpers
# ══════════════════════════════════════════════════════════════════════════

def _parse_active_hours(schedule: dict[str, Any]) -> tuple[time, time] | None:
    """Parse active_hours from schedule JSON, e.g. '09:00-22:00'."""
    raw = schedule.get("active_hours", "")
    if not raw or "-" not in raw:
        return None
    try:
        parts = raw.split("-", 1)
        start = time.fromisoformat(parts[0].strip())
        end = time.fromisoformat(parts[1].strip())
        return (start, end)
    except (ValueError, IndexError):
        return None


def _is_within_active_hours(schedule: dict[str, Any]) -> bool:
    """Check if the current UTC time is within the persona's active window."""
    hours = _parse_active_hours(schedule)
    if hours is None:
        return True  # No restriction configured
    start, end = hours
    now_time = datetime.now(timezone.utc).time()
    if start <= end:
        return start <= now_time <= end
    # Overnight window, e.g. 22:00-06:00
    return now_time >= start or now_time <= end


def _get_max_messages_day(schedule: dict[str, Any]) -> int:
    """Extract daily message cap from schedule JSON."""
    return int(schedule.get("max_messages_day", 10))


# ══════════════════════════════════════════════════════════════════════════
# Account connection (mirrors dm_campaign_tasks pattern)
# ══════════════════════════════════════════════════════════════════════════

def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    # P5-02: delegate to the shared builder (was duplicated across ~10 modules).
    from app.services.tg_runner import build_proxy_kwargs
    return build_proxy_kwargs(db, proxy_id)



def _connect_account_info(db: Any, account_id: str) -> dict[str, Any] | None:
    """Load account row, decrypt session, build connection info."""
    acc = db.execute(
        "SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'", [account_id]
    ).fetchone()
    if not acc:
        return None
    meta = json.loads(acc["metadata"] or "{}")
    app_id = meta.get("app_id")
    app_hash = meta.get("app_hash")
    if not app_id or not app_hash:
        return None
    session_bytes = decrypt_bytes(Path(acc["session_path"]).read_bytes())
    proxy_kwargs = _build_proxy_kwargs(db, acc["proxy_id"]) if acc["proxy_id"] else {}
    return {
        "account_id": acc["id"],
        "phone": acc["phone"],
        "tg_user_id": acc["tg_user_id"],
        "session_bytes": session_bytes,
        "app_id": int(app_id),
        "app_hash": str(app_hash),
        "twofa": meta.get("twoFA") or meta.get("twofa_password"),
        "proxy_kwargs": proxy_kwargs,
    }


async def _make_client(acc_info: dict[str, Any]) -> tuple[Any, Path]:
    """Create a connected TelegramClient and return (client, tmp_dir).

    Caller is responsible for disconnecting the client and cleaning up
    the temporary directory.
    """
    from telethon import TelegramClient
    from telethon.errors import AuthKeyUnregisteredError, UserDeactivatedBanError

    tmp_dir = Path(tempfile.mkdtemp(prefix="ai_agent_"))
    tmp_session = tmp_dir / "agent.session"
    tmp_session.write_bytes(acc_info["session_bytes"])

    client = TelegramClient(
        str(tmp_session.with_suffix("")),
        acc_info["app_id"],
        acc_info["app_hash"],
        timeout=30,
        connection_retries=5,
        retry_delay=2,
        **acc_info["proxy_kwargs"],
    )

    await client.connect()
    if not await client.is_user_authorized():
        if acc_info["twofa"]:
            await client.sign_in(password=str(acc_info["twofa"]))
        else:
            await client.disconnect()
            shutil.rmtree(str(tmp_dir), ignore_errors=True)
            raise RuntimeError("Account not authorized and no 2FA password")

    return client, tmp_dir


async def _disconnect_client(client: Any, tmp_dir: Path) -> None:
    """Safely disconnect a TelegramClient and remove its temp dir."""
    try:
        await client.disconnect()
    except Exception:
        pass
    shutil.rmtree(str(tmp_dir), ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════
# RAG: keyword-based chunk search
# ══════════════════════════════════════════════════════════════════════════

def _search_kb_chunks(
    db: Any,
    doc_ids: list[str],
    query: str,
    limit: int = 3,
) -> list[str]:
    """Return up to *limit* chunk texts relevant to *query*.

    Hybrid retrieval (P6-01): keyword + local vector cosine over the chunk
    ``embedding`` column, via the shared ``kb_search`` service. Falls back to
    keyword-only when embeddings are unavailable.
    """
    from app.services.kb_search import search_chunk_texts

    return search_chunk_texts(db, doc_ids, query, limit=limit)


def _build_rag_context(chunks: list[str]) -> str:
    """Format RAG chunks for injection into system prompt."""
    if not chunks:
        return ""
    parts = "\n\n---\n\n".join(chunks)
    return (
        "\n\nЧТО ТЫ ЗНАЕШЬ (ты этим лично пользуешься, разбираешься в теме):\n"
        f"---\n{parts}\n---\n"
        "Когда разговор заходит про это или тебя прямо просят рассказать — "
        "объясняй КОНКРЕТНО и УВЕРЕННО из этих знаний, как живой энтузиаст, "
        "который реально в теме. НЕ отнекивайся («сам посмотри», «погугли», "
        "«расскажу потом», «я сдалась») — это выглядит как увиливание и палит. "
        "Если назвали ботом/шиллером — не оправдывайся и не отступай, спокойно "
        "отшутись и продолжай как обычный человек, который просто пользуется и "
        "может по-простому объяснить (без маркетинга и пафоса).\n"
        "ВАЖНО: говори ТОЛЬКО то, что есть в этих знаниях. Не приписывай тому, о "
        "чём рассказываешь, фич, которых тут нет (напр. не выдумывай «стейкинг», "
        "если его тут нет). Если проект ещё не запущен — так и говори ("
        "«пока на старте/до запуска», «сам тестирую/слежу»), не ври что это уже live."
    )


# ══════════════════════════════════════════════════════════════════════════
# Self-learning feedback loop (HYBRID: few-shot + anti-patterns + humanization)
# ══════════════════════════════════════════════════════════════════════════

# Always-on humanization rules: make replies read like a real person, not a bot.
_HUMANIZATION_BLOCK = (
    "\n\nГлавное — звучи как живой человек, а не бот:\n"
    "- Короткие ответы (1-2 предложения), без воды и канцелярита.\n"
    "- Разговорный тон, можно строчные буквы и мелкие опечатки.\n"
    "- Никаких корпоративных/роботизированных формулировок.\n"
    "- Не отвечай на всё подряд — реагируй только когда есть что сказать.\n"
    "- Меняй стиль, не используй шаблонные фразы."
)


def _fetch_feedback_examples(
    db: Any,
    persona_id: str,
    *,
    limit: int = 5,
    max_chars: int = 200,
) -> tuple[list[str], list[str]]:
    """Return (good_examples, bad_examples) for *persona_id* from moderator ratings.

    Good examples are recent 'good'-rated ai_text; bad examples are recent
    'bad'-rated ai_text with the moderator note appended when present. Each
    example is truncated to *max_chars* to keep token use sane. Tolerant: any
    query error logs a warning and returns empty lists so generation proceeds.
    """
    try:
        good_rows = db.execute(
            "SELECT ai_text FROM tg_ai_messages "
            "WHERE persona_id = ? AND moderator_rating = 'good' "
            "AND ai_text IS NOT NULL AND ai_text != '' "
            "ORDER BY created_at DESC LIMIT ?",
            [persona_id, limit],
        ).fetchall()
        bad_rows = db.execute(
            "SELECT ai_text, moderator_note FROM tg_ai_messages "
            "WHERE persona_id = ? AND moderator_rating = 'bad' "
            "AND ai_text IS NOT NULL AND ai_text != '' "
            "ORDER BY created_at DESC LIMIT ?",
            [persona_id, limit],
        ).fetchall()

        good = [r["ai_text"].strip()[:max_chars] for r in good_rows if r["ai_text"]]

        bad: list[str] = []
        for r in bad_rows:
            text = (r["ai_text"] or "").strip()[:max_chars]
            if not text:
                continue
            note = (r["moderator_note"] or "").strip()
            if note:
                text = f"{text} (причина: {note[:max_chars]})"
            bad.append(text)

        return good, bad
    except Exception:
        log.warning("feedback_fetch_failed", persona_id=persona_id, exc_info=True)
        return [], []


def _build_feedback_block(good: list[str], bad: list[str]) -> str:
    """Format few-shot good examples + anti-patterns + humanization for the prompt."""
    parts: list[str] = []

    if good:
        parts.append("\n\nПримеры удачных ответов (подражай этому живому стилю):")
        for ex in good:
            parts.append(f"- {ex}")

    if bad:
        parts.append("\n\nТак отвечать НЕ надо (избегай этого):")
        for ex in bad:
            parts.append(f"- {ex}")

    parts.append(_HUMANIZATION_BLOCK)
    return "\n".join(parts)


def _fetch_style_examples(db: Any, topic: str | None = None, k: int = 5) -> list[str]:
    """Pull K random dialogue snippets from the style bank (topic-preferred).

    Powers "training on real conversations": these are anonymized real exchanges
    the agent imitates for TONE/length/slang (not content). Prefers the persona's
    topic, fills the rest from the global pool. Best-effort: errors → []."""
    rows: list[Any] = []
    try:
        if topic:
            rows = db.execute(
                "SELECT snippet FROM tg_style_samples WHERE topic = ? ORDER BY RANDOM() LIMIT ?",
                [topic, k],
            ).fetchall()
        if len(rows) < k:
            more = db.execute(
                "SELECT snippet FROM tg_style_samples ORDER BY RANDOM() LIMIT ?",
                [k - len(rows)],
            ).fetchall()
            rows = list(rows) + list(more)
    except Exception:  # noqa: BLE001
        return []
    return [r["snippet"] for r in rows]


def _build_style_block(snippets: list[str]) -> str:
    """Format style snippets as a few-shot block telling the agent to copy the
    LIVE style (tone/length/slang) but never the text or topic."""
    lines: list[str] = []
    for s in snippets[:6]:
        try:
            turns = json.loads(s)
        except (ValueError, TypeError):
            continue
        if len(turns) >= 2:
            q = (turns[0].get("t") or "").strip()
            a = (turns[1].get("t") or "").strip()
            if q and a:
                lines.append(f"— «{q}» → «{a}»")
        elif turns:
            t = (turns[0].get("t") or "").strip()
            if t:
                lines.append(f"— «{t}»")
    if not lines:
        return ""
    return (
        "\n\nКАК ПИШУТ ЖИВЫЕ ЛЮДИ В ЧАТАХ (реальные примеры стиля — копируй "
        "ТОН, краткость, разговорность, простоту и небрежность; НЕ копируй текст "
        "и тему, они тут не важны):\n" + "\n".join(lines)
    )


# ══════════════════════════════════════════════════════════════════════════
# AI cost tracking & budget
# ══════════════════════════════════════════════════════════════════════════

def _track_ai_cost(db: Any, cost_usd: float) -> None:
    """Increment ai_spent_this_month_usd in tg_settings."""
    try:
        db.execute(
            "UPDATE tg_settings SET ai_spent_this_month_usd = ai_spent_this_month_usd + ? WHERE id = 'default'",
            [cost_usd],
        )
        db.commit()
    except Exception:
        log.warning("ai_cost_track_failed", cost_usd=cost_usd, exc_info=True)


def _check_ai_budget(db: Any) -> bool:
    """Return True if monthly AI budget has NOT been exceeded."""
    stg = db.execute("SELECT * FROM tg_settings WHERE id = 'default'").fetchone()
    if not stg:
        return True
    limit = stg["ai_monthly_limit_usd"] or 500.0
    spent = stg["ai_spent_this_month_usd"] or 0.0
    return spent < limit


# ══════════════════════════════════════════════════════════════════════════
# System prompt builders
# ══════════════════════════════════════════════════════════════════════════

def _infer_gender(first_name: str | None) -> str | None:
    """Best-effort RU gender from a first name, so the agent uses the right verb
    forms ("запуталась" vs "запутался"). Heuristic: female if the name ends in
    а/я, minus common male exceptions. Returns "ж" / "м" / None (unknown)."""
    n = (first_name or "").strip().lower()
    if not n:
        return None
    n = n.split()[0]  # first token only
    unisex = {"саша", "женя", "валя", "слава"}
    if n in unisex:
        return None
    male_aya = {"никита", "илья", "лёша", "лёва", "фома", "кузьма", "савва",
                "данила", "гаврила", "добрыня", "серёга", "лука", "фока"}
    if n in male_aya:
        return "м"
    return "ж" if n.endswith(("а", "я")) else "м"


def _build_identity_block(own_name: str | None, own_username: str | None) -> str:
    """Tell the agent WHO IT IS in the chat — critical anti-"third person" guard
    and gender guard.

    Without this the agent doesn't know that "Вика"/"Виктория"/"@vika_web3" in
    the chat refers to ITSELF, so it starts commenting on itself in the third
    person and reads like two different people. It also doesn't know its gender,
    so it picks wrong verb forms. We pin the account's real Telegram display
    name + @username + inferred gender and forbid third-person self-reference.
    """
    if not own_name and not own_username:
        return ""
    who = own_name or (("@" + own_username) if own_username else "")
    handle = f" (@{own_username})" if own_username else ""
    gender = _infer_gender(own_name)
    gender_line = ""
    if gender == "ж":
        gender_line = (
            " Ты ЖЕНЩИНА — говори о себе в женском роде (например «сделала», "
            "«запуталась», «вбухала», «была»), никогда в мужском."
        )
    elif gender == "м":
        gender_line = (
            " Ты МУЖЧИНА — говори о себе в мужском роде («сделал», «был»), "
            "никогда в женском."
        )
    return (
        f"\n\nТВОЯ ЛИЧНОСТЬ В ЧАТЕ: тебя зовут {who}{handle}.{gender_line} "
        f"Когда в чате пишут «{own_name or own_username}»"
        + (f", «{own_name.split()[0]}»" if own_name and " " in own_name else "")
        + (f" или «@{own_username}»" if own_username else "")
        + " — имеют в виду ТЕБЯ. Всегда говори от ПЕРВОГО лица как "
        f"{own_name or own_username}. НИКОГДА не упоминай себя в третьем лице и не "
        "комментируй свои же сообщения как посторонний — это сразу выдаёт бота."
    )


def _build_chat_system_prompt(
    persona: dict[str, Any],
    rag_context: str = "",
    feedback_block: str = "",
    own_name: str | None = None,
    own_username: str | None = None,
) -> str:
    """Build the system prompt for chat engagement."""
    parts: list[str] = [
        "You are an AI persona participating in Telegram group chats.",
        "Your goal is to contribute meaningfully to conversations, build"
        " credibility, and subtly promote relevant topics when appropriate.",
        _build_identity_block(own_name, own_username),
        "",
    ]

    if persona.get("name"):
        parts.append(f"Your name: {persona['name']}")
    if persona.get("niche"):
        parts.append(f"Your niche/expertise: {persona['niche']}")
    if persona.get("bio"):
        parts.append(f"Your bio: {persona['bio']}")
    if persona.get("personality"):
        parts.append(f"Your personality: {persona['personality']}")

    strategy = persona.get("strategy", "soft")
    strategy_instructions = {
        "soft": (
            "Strategy: SOFT -- Be naturally helpful, share knowledge, build trust."
            " Never hard-sell. Promotion should be invisible and organic."
            " Focus on providing value first."
        ),
        "medium": (
            "Strategy: MEDIUM -- Balance helpfulness with subtle promotion."
            " You can mention relevant products/services when contextually"
            " appropriate. Be conversational but gently guide interest."
        ),
        "aggressive": (
            "Strategy: AGGRESSIVE -- Actively promote when opportunities arise."
            " Be direct about recommendations. Still maintain conversational"
            " tone but don't shy away from clear calls to action."
        ),
    }
    parts.append("")
    parts.append(strategy_instructions.get(strategy, strategy_instructions["soft"]))

    parts.extend([
        "",
        "Rules:",
        "- Write in the same language as the conversation (usually Russian).",
        "- Keep replies concise (1-3 sentences typically).",
        "- Match the chat's tone and energy level.",
        "- Never reveal you are an AI or automated.",
        "- Do not reply to messages that are clearly not worth engaging with.",
        "- Use natural chat language, including informal expressions where appropriate.",
        "- Do not use markdown formatting unless the chat commonly does.",
        "",
        "АНТИ-РОБОТ (критично, иначе спалишься):",
        "- НИКОГДА не используй длинное тире (—, –). Это главный признак бота. Только запятая, точка или короткий дефис.",
        "- Не пиши идеально-грамотно и формально. Пиши как в мессенджере: можно строчными, без точки в конце, с разговорными словечками (ну, хз, кстати, вроде, да не, ага).",
        "- Запрещены штампы: «Конечно!», «Разумеется», «Безусловно», «Я думаю, что важно отметить», «Однако стоит учитывать», списки с тире/буллеты.",
        "- Варьируй: иногда односложно («ага», «+», «не, такое себе»), иногда вопрос, иногда чуть не по теме или с лёгкой шуткой. Не отвечай шаблонно.",
        "- Не повторяй структуру прошлых ответов. Живой человек пишет по-разному.",
        "- Эмодзи редко и к месту (0-1), не в каждом сообщении.",
        "- Думай как реальный участник: сначала пойми о чём речь и какое настроение, потом отвечай естественно по смыслу.",
        "",
        "СОДЕРЖАНИЕ (чтобы не звучать как поддакивающий бот):",
        "- НЕ поддакивай всему подряд. Не пиши пустой хайп: «будет огонь», «это кайф», «вообще топ», «жду встречи», «звучит классно». Это бессмысленная вода, сразу палит бота.",
        "- Добавляй КОНКРЕТИКУ или своё мнение: спроси деталь, предложи своё, вспомни случай, можешь и не согласиться или подколоть. Иногда нейтрально/скептически.",
        "- Отвечай на СУТЬ конкретного сообщения, а не общими словами. Если по сути сказать нечего — лучше промолчи или поставь реакцию, чем лить воду.",
        "- НЕ повторяй смысл/настроение своих прошлых сообщений в этом чате. Каждый раз по-новому.",
        "- Будь живым человеком со своим характером, а не вечно-позитивным ботом-одобрителем.",
        "",
        "ДВУСТОРОННИЙ ДИАЛОГ (важно, не просто отбивайся):",
        "- Не закрывай разговор сухим ответом. Живой человек ЛЮБОПЫТЕН: подхватывает деталь, делится своим, развивает тему.",
        "- ЧАСТО (примерно в половине ответов) задавай встречный вопрос или продолжай мысль собеседника, чтобы беседа жила, а не обрывалась. Но НЕ в каждом сообщении (иначе как допрос/бот).",
        "- Встречный вопрос должен быть по делу и из любопытства (а не дежурное «а ты как?»): зацепись за конкретику из их сообщения.",
        "- Иногда вместо вопроса поделись своим опытом/мнением так, чтобы собеседнику захотелось ответить.",
        "",
        "ЧИТАЙ КОНТЕКСТ ЧАТА (открытость и баланс):",
        "- Это ОБЫЧНЫЙ болтательный чат на любые темы (название чата НЕ ограничивает тему — не привязывайся к нему буквально). Тут общаются обо всём: крипта, жизнь, кино, новости, мемы.",
        "- Будь РАСКРЕПОЩЁННОЙ и общительной: не жди прямого вопроса, сама подхватывай любую тему, реагируй на то, что пишут и ПЕРЕСЫЛАЮТ (новости, картинки с подписью, мемы) — живо, с интересом, со своим мнением.",
        "- Если прислали/подняли тему близкую тебе (крипта, доход, проекты, мемкоины) — РАДУЙСЯ и включайся по делу, это твоё. НИКОГДА не отмахивайся «это не по теме чата» — тем чата нет, тема чата это что обсуждают прямо сейчас.",
        "- При этом не превращайся в моно-продажника: не в каждом сообщении про свой проект, иначе «ты бот/шиллишь». Свою тему углубляй когда в тему/спросили, но общую крипто-движуху поддерживай свободно.",
        "",
        "ДОСТОИНСТВО И УВЕРЕННОСТЬ:",
        "- Не складывай лапки и не извиняйся за свои интересы. НЕ пиши «сдаюсь», «сдалась», «может я переусложняю», «не буду мудрить». Держи мнение легко, но уверенно.",
        "- На грубость, пошлость или провокацию («поставлю на колени», «брила?», «ты транс?») НЕ подыгрывай и не оправдывайся: коротко отшейся с лёгкой иронией или просто переведи тему. С достоинством.",
        "- Не противоречь тому, что уже говорил(а) в этом чате. Если сказал(а) «просто читаю новости» — не превращайся вдруг в эксперта-трейдера.",
    ])

    # Append custom system prompt
    custom = (persona.get("system_prompt") or "").strip()
    if custom:
        parts.extend(["", "Additional instructions:", custom])

    # Append RAG context
    if rag_context:
        parts.append(rag_context)

    # Append self-learning feedback (few-shot good + anti-patterns + humanization)
    if feedback_block:
        parts.append(feedback_block)

    return "\n".join(parts)


def _build_dm_system_prompt(
    persona: dict[str, Any],
    chat_title: str,
    topic: str,
    rag_context: str = "",
) -> str:
    """Build the system prompt for DM outreach conversations."""
    parts: list[str] = [
        "You are communicating via Telegram DM with someone you met in a group chat.",
        f"You noticed them in the chat '{chat_title}' discussing '{topic}'.",
        "Your goal is to build a relationship and naturally guide the conversation"
        " towards your project/product.",
        "",
    ]

    if persona.get("name"):
        parts.append(f"Your name: {persona['name']}")
    if persona.get("niche"):
        parts.append(f"Your niche/expertise: {persona['niche']}")
    if persona.get("bio"):
        parts.append(f"Your bio: {persona['bio']}")
    if persona.get("personality"):
        parts.append(f"Your personality: {persona['personality']}")

    strategy = persona.get("strategy", "soft")
    if strategy == "soft":
        parts.append(
            "\nApproach: Start with genuine curiosity about their interests."
            " Share knowledge naturally. Mention your project only when it"
            " genuinely fits the conversation."
        )
    elif strategy == "medium":
        parts.append(
            "\nApproach: Be friendly and show genuine interest, but don't"
            " hesitate to mention your project when relevant. Ask open-ended"
            " questions that naturally lead to your offering."
        )
    else:
        parts.append(
            "\nApproach: Be direct and professional. Express interest in"
            " collaboration and present your project clearly. Still keep"
            " a conversational, human tone."
        )

    parts.extend([
        "",
        "Rules:",
        "- Keep messages concise and natural, like a real person in a messenger.",
        "- Do NOT use markdown formatting, headers, or bullet points.",
        "- Do NOT reveal that you are an AI.",
        "- Write in the same language the user writes to you.",
        "- Be conversational, friendly, and professional.",
        "- Use knowledge base info naturally, do not dump raw facts.",
    ])

    custom = (persona.get("system_prompt") or "").strip()
    if custom:
        parts.extend(["", "Additional instructions:", custom])

    if rag_context:
        parts.append(rag_context)

    return "\n".join(parts)


# ══════════════════════════════════════════════════════════════════════════
# Universal DM secretary — per-thread state + summary + system prompt
# ══════════════════════════════════════════════════════════════════════════

def _upsert_dm_thread(
    db: Any,
    account_id: str,
    peer_id: int,
    peer_username: str | None,
    peer_name: str | None,
) -> dict[str, Any]:
    """Get or create a tg_dm_threads row for (account_id, peer_id).

    Refreshes peer_username/peer_name if they changed (people rename). Always
    bumps last_msg_at — caller observed an incoming message. Returns the row
    as a dict (caller treats it read-only after).
    """
    row = db.execute(
        "SELECT * FROM tg_dm_threads WHERE account_id = ? AND peer_id = ?",
        [account_id, peer_id],
    ).fetchone()
    now = _now()
    if not row:
        thread_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO tg_dm_threads "
            "(id, account_id, peer_id, peer_username, peer_name, "
            " last_msg_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [thread_id, account_id, peer_id, peer_username or None,
             peer_name or None, now, now, now],
        )
        db.commit()
        row = db.execute(
            "SELECT * FROM tg_dm_threads WHERE id = ?", [thread_id]
        ).fetchone()
    else:
        # Refresh identity if changed; bump last_msg_at.
        existing = dict(row)
        new_username = peer_username or existing.get("peer_username")
        new_name = peer_name or existing.get("peer_name")
        if (
            new_username != existing.get("peer_username")
            or new_name != existing.get("peer_name")
        ):
            db.execute(
                "UPDATE tg_dm_threads SET peer_username=?, peer_name=?, "
                "last_msg_at=?, updated_at=? WHERE id=?",
                [new_username, new_name, now, now, existing["id"]],
            )
        else:
            db.execute(
                "UPDATE tg_dm_threads SET last_msg_at=?, updated_at=? WHERE id=?",
                [now, now, existing["id"]],
            )
        db.commit()
        row = db.execute(
            "SELECT * FROM tg_dm_threads WHERE id = ?", [existing["id"]]
        ).fetchone()
    return dict(row) if row else {}


async def _refresh_dm_summary(
    persona: dict[str, Any],
    old_summary: str,
    msgs: list[Any],
    model: str,
) -> tuple[str | None, float]:
    """Compress the dialog into a short summary (RU, ≤ 5 sentences).

    Cheap, low-temperature call. Returns (new_summary, cost_usd); (None, 0) on
    failure — caller keeps the old summary and proceeds (refresh is best-effort).
    """
    try:
        from app.ai.anthropic_client import generate_message

        lines: list[str] = []
        for m in msgs[-30:]:  # cap context: enough to capture the gist
            if not getattr(m, "text", None):
                continue
            who = "Я" if getattr(m, "out", False) else "Собеседник"
            lines.append(f"{who}: {m.text[:300]}")
        if not lines:
            return (None, 0.0)
        convo = "\n".join(lines)

        sys = (
            "Ты ведёшь рабочую память личного ассистента в Telegram. Сожми "
            "диалог ниже в краткое summary на русском: кто собеседник, его "
            "интерес/запрос, что уже обсудили, текущая стадия, важные детали "
            "(имена, ссылки, числа). Не больше 5 коротких предложений. Без "
            "маркеров, без воды. Если есть предыдущий summary — учти его и "
            "обнови, не дублируй. Верни ТОЛЬКО текст summary."
        )
        user_parts: list[str] = []
        if old_summary:
            user_parts.append(f"Предыдущее summary:\n{old_summary}")
        user_parts.append(f"Диалог (последние сообщения):\n{convo}")
        user = "\n\n".join(user_parts)

        res = generate_message(
            system_prompt=sys, user_message=user, model=model,
            max_tokens=300, temperature=0.3,
        )
        text = (res.get("text") or "").strip()
        return (text or None, float(res.get("cost_usd") or 0.0))
    except Exception:  # noqa: BLE001
        log.warning("dm_summary_refresh_failed", exc_info=True)
        return (None, 0.0)


# ── Staged sales funnel (P6-09) — ported pure helpers from ai_sales_tasks ──────
# These let the DM secretary run a structured staged dialog when the persona is
# bound to a tg_sales_scripts funnel. Kept here (not imported from the off-runtime
# ai_sales_tasks) so the live agent stays self-contained.

def _funnel_get_stages(script_row: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse the stages JSON array from a tg_sales_scripts row."""
    raw = script_row.get("stages") or "[]"
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        return parsed if isinstance(parsed, list) else []
    return raw if isinstance(raw, list) else []


def _funnel_stage_obj(stages: list[dict[str, Any]], name: str | None) -> dict[str, Any] | None:
    for st in stages:
        if st.get("name") == name:
            return st
    return None


def _funnel_advance(stages: list[dict[str, Any]], current_stage: str, user_message: str) -> str | None:
    """Return next_stage if the message contains the current stage's advance_keywords."""
    msg = (user_message or "").lower()
    st = _funnel_stage_obj(stages, current_stage)
    if st is None:
        return None
    for kw in st.get("advance_keywords") or []:
        if kw and str(kw).lower() in msg:
            return st.get("next_stage")
    return None


def _funnel_is_terminal(stages: list[dict[str, Any]], name: str | None) -> bool:
    """A stage is terminal if flagged ``terminal`` or has no ``next_stage``."""
    st = _funnel_stage_obj(stages, name)
    if st is None:
        return False
    return bool(st.get("terminal") or not st.get("next_stage"))


def _funnel_stage_section(stages: list[dict[str, Any]], current_stage: str) -> str:
    """Build the stage-context block injected into the secretary system prompt."""
    if not stages:
        return ""
    names = [s.get("name", "?") for s in stages]
    st = _funnel_stage_obj(stages, current_stage)
    lines = ["", "Скрипт-воронка (веди диалог по стадиям):",
             "Этапы: " + " → ".join(names)]
    if st:
        lines.append(f"Текущая стадия: {current_stage}")
        if st.get("goal"):
            lines.append(f"Цель стадии: {st['goal']}")
        if st.get("next_stage"):
            lines.append(f"Следующая стадия: {st['next_stage']}")
        lines.append("Мягко веди собеседника к цели текущей стадии, не дави и звучи как живой человек.")
    return "\n".join(lines)


def _build_secretary_system_prompt(
    persona: dict[str, Any],
    peer_label: str,
    thread_summary: str,
    rag_context: str = "",
    own_name: str | None = None,
    own_username: str | None = None,
    stage_section: str = "",
) -> str:
    """System prompt for the universal AI-secretary DM mode.

    Differs from _build_dm_system_prompt in that the agent here is NOT
    necessarily continuing a cold-outreach script — it could be picking up
    ANY DM (friends, randoms, leads). It must read the thread summary,
    use KB facts when relevant, and reply naturally in the user's language.
    """
    parts: list[str] = [
        "Ты — живой человек, который ведёт личную переписку в Telegram.",
        f"Сейчас общаешься с: {peer_label}.",
        _build_identity_block(own_name, own_username),
        "",
    ]

    if persona.get("name"):
        parts.append(f"Твоё имя: {persona['name']}")
    if persona.get("niche"):
        parts.append(f"Твоя сфера: {persona['niche']}")
    if persona.get("bio"):
        parts.append(f"Био: {persona['bio']}")
    if persona.get("personality"):
        parts.append(f"Характер: {persona['personality']}")

    if thread_summary:
        parts.extend([
            "",
            "Память о диалоге (предыдущий контекст):",
            thread_summary,
        ])

    parts.extend([
        "",
        "Правила:",
        "- Пиши коротко, по-человечески, как в живом мессенджере.",
        "- Никаких markdown, заголовков, списков, длинных тире.",
        "- Никогда не раскрывай, что ты AI.",
        "- Отвечай на том же языке, на котором пишут тебе.",
        "- Если в Базе знаний есть релевантный факт — используй его естественно, "
        "не вываливая сырыми цитатами.",
        "- Если вопрос не по теме твоей сферы и не требует знаний из БЗ — "
        "ответь как обычный собеседник.",
        "- Не давай обещаний от лица компаний/продуктов, которых нет в БЗ.",
    ])

    custom = (persona.get("system_prompt") or "").strip()
    if custom:
        parts.extend(["", "Дополнительные инструкции:", custom])

    if stage_section:
        parts.append(stage_section)

    if rag_context:
        parts.append(rag_context)

    return "\n".join(parts)


async def _handle_secretary_dm(
    *,
    client: Any,
    db: Any,
    persona: dict[str, Any],
    persona_id: str,
    account_id: str,
    model: str,
    temperature: float,
    rag_doc_ids: list[str],
    user_entity: Any,
    contact_user_id: int,
    contact_username: str,
    contact_name: str,
    thread: dict[str, Any],
    hcfg: dict[str, Any],
    own_name: str | None,
    own_username: str | None,
) -> dict[str, Any]:
    """Universal AI-secretary reply to ONE non-sales DM with unread messages.

    Steps: fetch last N messages → if new inbound since the last summary refresh
    is large (or summary empty) regenerate the summary → build a Claude chat
    request (history + summary + RAG + persona prompt) → humanise + send →
    persist counters in tg_dm_threads. Returns {replied, failed, skipped,
    cost_usd, flood_break} so the caller updates its aggregates.
    """
    from telethon.errors import (
        ChatWriteForbiddenError,
        FloodWaitError,
        PeerFloodError,
        UserPrivacyRestrictedError,
    )

    result = {"replied": 0, "failed": 0, "skipped": 0, "cost_usd": 0.0, "flood_break": False}

    # Pull recent history. 30 is enough to capture context for a DM thread
    # without blowing the prompt budget.
    try:
        history = await client.get_messages(user_entity, limit=30)
    except Exception as exc:  # noqa: BLE001
        log.warning("dm_secretary_history_failed",
                    peer=contact_username or contact_user_id, error=str(exc)[:160])
        result["failed"] = 1
        return result
    history = list(reversed(history))  # oldest first

    inbound_only = [m for m in history if not getattr(m, "out", False) and getattr(m, "text", None)]
    if not inbound_only:
        return result

    # Idempotency: if the newest inbound msg id is not newer than what we last
    # replied to (tracked via last_summarized_msg_id), skip — Telegram's
    # unread_count occasionally lags after our ack.
    last_inbound = inbound_only[-1]
    newest_in_id = int(getattr(last_inbound, "id", 0) or 0)
    last_seen_id = int(thread.get("last_summarized_msg_id") or 0)

    # Budget gate (per-cycle in caller too — second check is cheap insurance).
    if not _check_ai_budget(db):
        result["skipped"] = 1
        return result

    # ── Summary refresh (cheap, low temp) ──────────────────────────────
    old_summary = thread.get("summary") or ""
    new_inbound_since = sum(1 for m in inbound_only if int(getattr(m, "id", 0) or 0) > last_seen_id)
    must_refresh = (not old_summary) or (new_inbound_since >= 5)
    summary = old_summary
    if must_refresh:
        new_summary, scost = await _refresh_dm_summary(persona, old_summary, history, model)
        result["cost_usd"] += scost
        if new_summary:
            summary = new_summary
            try:
                db.execute(
                    "UPDATE tg_dm_threads SET summary=?, last_summarized_msg_id=?, "
                    "msgs_since_summary=0, updated_at=? WHERE id=?",
                    [summary, newest_in_id, _now(), thread["id"]],
                )
                db.commit()
            except Exception:  # noqa: BLE001
                log.debug("dm_summary_persist_failed", thread_id=thread["id"], exc_info=True)

    # ── RAG: search KB on the last inbound message (the thing we answer) ─
    rag_chunks: list[str] = []
    if rag_doc_ids and last_inbound.text:
        rag_chunks = _search_kb_chunks(db, rag_doc_ids, last_inbound.text)
    rag_context = _build_rag_context(rag_chunks)

    # ── Build chat-style messages from the last 20 turns ──────────────
    conv_messages: list[dict[str, str]] = []
    for m in history[-20:]:
        text = getattr(m, "text", None)
        if not text:
            continue
        role = "assistant" if getattr(m, "out", False) else "user"
        conv_messages.append({"role": role, "content": text})
    if not conv_messages or conv_messages[-1]["role"] != "user":
        # Nothing to answer to (last turn was ours / no text inbound) — skip.
        return result

    # ── Staged sales funnel (P6-09): opt-in via persona.funnel_script_id ──
    # When bound to a tg_sales_scripts funnel, track the dialog stage in
    # tg_dm_threads.funnel_stage, advance it on the user's advance_keywords, and
    # inject the stage goal into the prompt. NULL binding / missing script / no
    # stages → no-op (plain secretary behaviour, unchanged).
    stage_section = ""
    funnel_script_id = persona.get("funnel_script_id")
    if funnel_script_id:
        try:
            script_row = db.execute(
                "SELECT * FROM tg_sales_scripts WHERE id = ?", [funnel_script_id]
            ).fetchone()
        except Exception:  # noqa: BLE001
            script_row = None
        if script_row:
            script = dict(script_row)
            stages = _funnel_get_stages(script)
            if stages:
                current_stage = thread.get("funnel_stage") or stages[0].get("name")
                # Advance on the latest inbound message (unless already terminal).
                if not _funnel_is_terminal(stages, current_stage):
                    nxt = _funnel_advance(stages, current_stage, last_inbound.text or "")
                    if nxt:
                        current_stage = nxt
                if current_stage != (thread.get("funnel_stage") or ""):
                    try:
                        db.execute(
                            "UPDATE tg_dm_threads SET funnel_stage=?, updated_at=? WHERE id=?",
                            [current_stage, _now(), thread["id"]],
                        )
                        db.commit()
                    except Exception:  # noqa: BLE001
                        log.debug("funnel_stage_persist_failed", thread_id=thread["id"], exc_info=True)
                stage_section = _funnel_stage_section(stages, current_stage)
                script_prompt = (script.get("system_prompt") or "").strip()
                if script_prompt:
                    stage_section = "Скрипт-продажи: " + script_prompt + "\n" + stage_section
                if _funnel_is_terminal(stages, current_stage):
                    log.info("funnel_terminal_reached", persona_id=persona_id,
                             peer=contact_user_id, stage=current_stage)

    peer_label = contact_name or (("@" + contact_username) if contact_username else f"user {contact_user_id}")
    sys_prompt = _build_secretary_system_prompt(
        persona, peer_label=peer_label, thread_summary=summary,
        rag_context=rag_context, own_name=own_name, own_username=own_username,
        stage_section=stage_section,
    )

    # ── Generation ─────────────────────────────────────────────────────
    try:
        from app.ai.anthropic_client import generate_chat

        ai_result = generate_chat(
            system_prompt=sys_prompt, messages=conv_messages,
            model=model, max_tokens=400, temperature=temperature,
        )
        reply_text = _humanize_text((ai_result.get("text") or "").strip())
        if not reply_text:
            result["skipped"] = 1
            return result
        cost = float(ai_result.get("cost_usd") or 0.0)
        result["cost_usd"] += cost
        _track_ai_cost(db, cost)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "dm_secretary_generate_failed",
            peer=contact_username or contact_user_id, error=str(exc)[:200],
        )
        result["failed"] = 1
        return result

    # ── Send with human pause + anti-ban error handling ────────────────
    try:
        delay = random.uniform(
            float(hcfg.get("delay_min_sec", 8)),
            float(hcfg.get("delay_max_sec", 90)),
        )
        await _human_pause(client, user_entity, delay)
        await _resilient_send(client, user_entity, reply_text)
    except FloodWaitError as e:
        log.warning("dm_secretary_flood", wait=e.seconds)
        if e.seconds > 300:
            db.execute(
                "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                [_now(), account_id],
            )
            db.commit()
            result["flood_break"] = True
        else:
            await asyncio.sleep(e.seconds + 5)
        result["failed"] = 1
        return result
    except PeerFloodError:
        db.execute(
            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
            [_now(), account_id],
        )
        db.commit()
        result["failed"] = 1
        result["flood_break"] = True
        return result
    except UserPrivacyRestrictedError:
        log.info("dm_secretary_privacy", peer=contact_username or contact_user_id)
        result["skipped"] = 1
        return result
    except ChatWriteForbiddenError:
        log.info("dm_secretary_forbidden", peer=contact_username or contact_user_id)
        result["skipped"] = 1
        return result
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "dm_secretary_send_failed",
            peer=contact_username or contact_user_id, error=str(exc)[:200],
        )
        result["failed"] = 1
        return result

    # ── Persist + ack read ─────────────────────────────────────────────
    inbound_count = len(inbound_only)
    try:
        db.execute(
            "UPDATE tg_dm_threads SET "
            "total_in = total_in + ?, total_out = total_out + 1, "
            "msgs_since_summary = msgs_since_summary + ?, "
            "last_replied_at = ?, last_msg_at = ?, updated_at = ? "
            "WHERE id = ?",
            [inbound_count, new_inbound_since or inbound_count,
             _now(), _now(), _now(), thread["id"]],
        )
        db.commit()
    except Exception:  # noqa: BLE001
        log.debug("dm_thread_counter_failed", thread_id=thread["id"], exc_info=True)
    try:
        await client.send_read_acknowledge(user_entity)
    except Exception:  # noqa: BLE001
        pass

    _log_activity(
        db, persona_id, str(contact_user_id),
        contact_username or contact_name or str(contact_user_id),
        "SENT",
        f"📩 ЛС {contact_username or contact_name}: «{reply_text[:140]}»",
        {"secretary": True, "thread_id": thread["id"]},
    )
    result["replied"] = 1
    return result


def _build_chat_user_message(
    chat_title: str,
    chat_about: str,
    recent_context: list[str],
    target_text: str,
) -> str:
    """Build the user message sent to Claude for chat reply generation."""
    lines = [f"Chat: {chat_title}"]
    if chat_about:
        lines.append(f"Chat description: {chat_about}")
    lines.append("")
    if recent_context:
        lines.append("Recent messages in the conversation:")
        for ctx in recent_context[-15:]:
            lines.append(f"  {ctx}")
        lines.append("")
    lines.append(f"Message to reply to:\n{target_text}")
    lines.append("")
    lines.append(
        "Generate a single natural reply to the above message."
        " Reply with ONLY the message text, no explanations or metadata."
    )
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════
# Interest detection
# ══════════════════════════════════════════════════════════════════════════

def _evaluate_interest(
    user_text: str,
    username: str,
    chat_context: str,
    model: str,
    temperature: float,
) -> int:
    """Ask Claude to rate user interest level 0-10. Returns the score."""
    from app.ai.anthropic_client import generate_message

    system = (
        "You are an interest evaluator. Based on the conversation context and the "
        "user's message, rate their interest level in the topic being discussed "
        "on a scale of 0 to 10.\n\n"
        "0 = No interest, random message, off-topic\n"
        "3 = Mild curiosity, asked a casual question\n"
        "5 = Moderate interest, engaged in conversation\n"
        "7 = High interest, asking specific questions, showing enthusiasm\n"
        "10 = Very high interest, asking for details, wants to participate\n\n"
        "Reply with ONLY a single integer number, nothing else."
    )

    user_msg = (
        f"Chat context:\n{chat_context}\n\n"
        f"User @{username} said:\n{user_text}\n\n"
        "Interest score (0-10):"
    )

    try:
        result = generate_message(
            system_prompt=system,
            user_message=user_msg,
            model=model,
            max_tokens=10,
            temperature=0.2,  # Low temperature for consistent scoring
        )
        # Track cost for this evaluation call too
        score_text = result["text"].strip()
        # Extract first integer from response
        match = re.search(r"\d+", score_text)
        if match:
            score = int(match.group())
            return min(10, max(0, score))
    except Exception as e:
        log.warning("interest_eval_error", error=str(e)[:100])

    return 0


# ══════════════════════════════════════════════════════════════════════════
# Celery task entry point
# ══════════════════════════════════════════════════════════════════════════

@celery_app.task(name="pup_tg.ai_agent", bind=True, max_retries=0)
def ai_agent(self, workspace_id: str, persona_id: str, loop_token: str | None = None) -> dict:
    """Execute one AI agent cycle, then self-reschedule while ACTIVE.

    The loop is self-perpetuating: after each scan/engage cycle it re-queues
    itself after ``scan_interval_sec`` (default 180s) — but ONLY while the
    persona is still ACTIVE and the ``loop_token`` still matches. Pausing the
    persona (status != ACTIVE) stops the loop; re-activating mints a new token
    so any stale in-flight loop dies on its next tick (no duplicate loops).
    """
    # Run one cycle. A cycle exception must NOT break the self-loop: capture it
    # and still fall through to the reschedule below, otherwise a single bad
    # cycle (network blip, transient Telethon error) would silently kill the
    # loop until the next worker restart / reaper sweep.
    try:
        result = asyncio.run(_ai_agent_async(workspace_id, persona_id))
    except Exception as exc:  # noqa: BLE001
        log.warning("ai_agent_cycle_failed", persona_id=persona_id, exc_info=True)
        result = {"status": "ERROR", "error": str(exc)}

    try:
        db = get_db(workspace_id)
        row = db.execute(
            "SELECT status, schedule FROM tg_ai_personas WHERE id = ?", [persona_id]
        ).fetchone()
        if row and row["status"] == "ACTIVE":
            schedule = json.loads(row["schedule"] or "{}")
            # Token guard: a newer activate supersedes this loop.
            if loop_token is None or schedule.get("loop_token") == loop_token:
                # Floor 15s allows near-real-time polling for snappy chats; the
                # self-loop reschedules only AFTER a cycle finishes, so cycles
                # never overlap regardless of how low this is.
                interval = max(15, min(int(schedule.get("scan_interval_sec", 180)), 3600))
                ai_agent.apply_async(
                    args=[workspace_id, persona_id, loop_token],
                    countdown=interval,
                    queue="pup_tg_default",
                )
                next_at = (datetime.now(timezone.utc) + timedelta(seconds=interval)).isoformat()
                _when = f"{interval} сек" if interval < 60 else f"{interval // 60} мин"
                _log_activity(
                    db, persona_id, None, None, "SLEEP",
                    f"Цикл завершён. Следующая проверка ~через {_when}",
                    {"next_at": next_at, "interval_sec": interval},
                )
                log.info("ai_agent_rescheduled", persona_id=persona_id, countdown=interval)
            else:
                log.info("ai_agent_loop_superseded", persona_id=persona_id)
    except Exception:
        log.warning("ai_agent_reschedule_failed", persona_id=persona_id, exc_info=True)

    return result


async def _ai_agent_async(workspace_id: str, persona_id: str) -> dict:
    from telethon.errors import (
        AuthKeyUnregisteredError,
        ChannelPrivateError,
        ChatWriteForbiddenError,
        FloodWaitError,
        PeerFloodError,
        UserBannedInChannelError,
        UserDeactivatedBanError,
        UserPrivacyRestrictedError,
    )
    from telethon.tl.functions.channels import GetFullChannelRequest

    db = get_db(workspace_id)

    # ── Load persona ───────────────────────────────────────────────────
    persona_row = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not persona_row:
        return {"status": "FAILED", "error": "Persona not found"}
    if persona_row["status"] != "ACTIVE":
        return {"status": "SKIPPED", "error": f"Persona status is {persona_row['status']}, not ACTIVE"}

    persona = dict(persona_row)
    schedule = json.loads(persona.get("schedule") or "{}")
    target_channels = json.loads(persona.get("target_channels") or "[]")
    account_ids = json.loads(persona.get("account_ids") or "[]")
    rag_doc_ids = json.loads(persona.get("rag_doc_ids") or "[]")
    context_depth = persona.get("context_depth") or 50
    dm_enabled = bool(persona.get("dm_enabled", 1))
    dm_reply_to_all = bool(persona.get("dm_reply_to_all", 1))
    model = _resolve_model(persona.get("ai_model"))
    temperature = persona.get("temperature") or 0.8

    # ── Self-learning feedback (HYBRID): few-shot good + anti-patterns ──
    # Fetched once per cycle and reused across channels. Tolerant: a query
    # error logs a warning and generation proceeds without examples.
    fb_good, fb_bad = _fetch_feedback_examples(db, persona_id)
    feedback_block = _build_feedback_block(fb_good, fb_bad)

    # Style bank (training on real conversations): few-shot snippets the agent
    # imitates for natural tone. Fetched once per cycle; re-rolled each cycle for
    # variety. Topic prefers the persona's, falls back to the global pool.
    _style_topic = (persona.get("niche") or "").strip() or None
    style_block = _build_style_block(_fetch_style_examples(db, _style_topic, k=5))

    if not target_channels:
        return {"status": "SKIPPED", "error": "No target channels configured"}
    if not account_ids:
        return {"status": "SKIPPED", "error": "No accounts linked to persona"}

    # ── Active hours check ─────────────────────────────────────────────
    if not _is_within_active_hours(schedule):
        log.info("ai_agent_outside_hours", persona_id=persona_id)
        _log_activity(db, persona_id, None, None, "SKIP",
                      "Сейчас вне активных часов — пропускаю цикл")
        return {"status": "SKIPPED", "error": "Outside active hours"}

    # ── Daily limit check ──────────────────────────────────────────────
    max_per_day = _get_max_messages_day(schedule)
    today_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    sent_today_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_messages WHERE persona_id = ? AND created_at >= ?",
        [persona_id, today_start],
    ).fetchone()
    sent_today = sent_today_row["cnt"] if sent_today_row else 0
    remaining_today = max(0, max_per_day - sent_today)

    if remaining_today <= 0:
        log.info("ai_agent_daily_limit", persona_id=persona_id, limit=max_per_day)
        _log_activity(db, persona_id, None, None, "SKIP",
                      f"Достигнут дневной лимит сообщений ({max_per_day}) — отдыхаю до завтра")
        return {"status": "SKIPPED", "error": f"Daily limit reached ({max_per_day})"}

    # ── Budget check ───────────────────────────────────────────────────
    if not _check_ai_budget(db):
        log.warning("ai_agent_budget_exceeded", persona_id=persona_id)
        _log_activity(db, persona_id, None, None, "SKIP",
                      "Превышен месячный AI-бюджет — пауза до пополнения")
        return {"status": "SKIPPED", "error": "AI monthly budget exceeded"}

    # ── Already-replied message IDs (avoid double-reply) ───────────────
    replied_rows = db.execute(
        "SELECT reply_to_msg_id, chat_id FROM tg_ai_messages "
        "WHERE persona_id = ? AND status IN ('SENT', 'PENDING', 'APPROVED')",
        [persona_id],
    ).fetchall()
    already_replied: set[tuple[str, int]] = set()
    for r in replied_rows:
        if r["reply_to_msg_id"] and r["chat_id"]:
            already_replied.add((str(r["chat_id"]), int(r["reply_to_msg_id"])))

    # ── Approval mode ──────────────────────────────────────────────────
    approval_mode = schedule.get("approval_mode", "AUTO").upper()

    # ── Aggregate results ──────────────────────────────────────────────
    total_chat_replies = 0
    total_chat_pending = 0
    total_dm_sent = 0
    total_dm_replied = 0
    total_failed = 0
    total_skipped = 0
    total_cost_usd = 0.0
    channel_results: list[dict[str, Any]] = []
    dm_queue: list[dict[str, Any]] = []  # Users to DM after Phase A

    # ═══════════════════════════════════════════════════════════════════
    # Process each account
    # ═══════════════════════════════════════════════════════════════════

    for acc_id in account_ids:
        if remaining_today <= 0:
            break

        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            log.warning("ai_agent_account_skip", account_id=acc_id, reason="not active or missing creds")
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, persona_id=persona_id)
            total_skipped += 1
            continue

        client = None
        tmp_dir = None

        try:
            client, tmp_dir = await _make_client(acc_info)
        except AuthKeyUnregisteredError:
            db.execute(
                "UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                [_now(), acc_id],
            )
            db.commit()
            log.error("ai_agent_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            log.error("ai_agent_account_banned", account_id=acc_id)
            continue
        except Exception as e:
            log.error("ai_agent_connect_error", account_id=acc_id, error=str(e)[:200])
            continue

        log.info("ai_agent_connected", persona_id=persona_id, account=acc_info["phone"])

        # Get own identity — user id, username AND display name. The display
        # name matters: without it the agent doesn't realise that "Вика" /
        # "Виктория" / "@vika_web3" in the chat is ITSELF, and starts talking
        # about itself in the third person (looks like two different people).
        own_user_id = acc_info.get("tg_user_id")
        own_username = None
        own_name = None
        try:
            me = await client.get_me()
            if me:
                own_user_id = me.id
                own_username = (me.username or "").lower() or None
                own_name = (me.first_name or "").strip() or None
        except Exception:
            pass

        # Human-behavior knobs (all tunable via persona schedule)
        hcfg = {
            "online_chance": float(schedule.get("online_chance", 0.7)),
            "reply_chance_directed": float(schedule.get("reply_chance_directed", 0.85)),
            "reply_chance_general": float(schedule.get("reply_chance_general", 0.30)),
            "reaction_chance": float(schedule.get("reaction_chance", 0.30)),
            "delay_min_sec": int(schedule.get("delay_min_sec", 8)),
            "delay_max_sec": int(schedule.get("delay_max_sec", 90)),
        }

        # Import AI client
        from app.ai.anthropic_client import generate_message, generate_chat

        # ═══════════════════════════════════════════════════════════════
        # PHASE A: Chat Engagement
        # ═══════════════════════════════════════════════════════════════

        for channel_ref in target_channels:
            if remaining_today <= 0:
                break

            ch_result: dict[str, Any] = {
                "channel": channel_ref,
                "generated": 0,
                "sent": 0,
                "pending": 0,
                "errors": [],
            }

            try:
                # ── Resolve channel entity ─────────────────────────────
                try:
                    entity = await client.get_entity(channel_ref)
                except ChannelPrivateError:
                    ch_result["errors"].append("CHANNEL_PRIVATE")
                    channel_results.append(ch_result)
                    log.warning("ai_agent_channel_private", channel=channel_ref)
                    continue
                except Exception as e:
                    ch_result["errors"].append(f"RESOLVE_ERROR: {str(e)[:80]}")
                    channel_results.append(ch_result)
                    log.warning("ai_agent_channel_resolve_error", channel=channel_ref, error=str(e)[:100])
                    continue

                chat_id = str(entity.id)
                chat_title = getattr(entity, "title", channel_ref) or channel_ref

                # ── Get chat description ───────────────────────────────
                chat_about = ""
                try:
                    if hasattr(entity, "broadcast") or hasattr(entity, "megagroup"):
                        full_chat = await client(GetFullChannelRequest(entity))
                        chat_about = getattr(full_chat.full_chat, "about", "") or ""
                except Exception:
                    # Not critical -- some chats don't allow GetFullChannel
                    pass

                # ── Read recent messages ───────────────────────────────
                messages = []
                try:
                    async for msg in client.iter_messages(entity, limit=context_depth):
                        messages.append(msg)
                except ChannelPrivateError:
                    ch_result["errors"].append("CHANNEL_PRIVATE")
                    channel_results.append(ch_result)
                    continue
                except Exception as e:
                    ch_result["errors"].append(f"FETCH_ERROR: {str(e)[:80]}")
                    channel_results.append(ch_result)
                    log.warning("ai_agent_fetch_error", channel=channel_ref, error=str(e)[:100])
                    continue

                if not messages:
                    channel_results.append(ch_result)
                    continue

                # ── Mark as read (human read-receipt) ──────────────────
                # A real person who is in the chat reads incoming messages, so
                # the sender sees ✓✓. Best-effort: never break the cycle.
                try:
                    await client.send_read_acknowledge(entity)
                except Exception:
                    pass

                # ── Build context from recent messages ─────────────────
                recent_context: list[str] = []
                for m in reversed(messages):
                    if m.text:
                        sender_name = ""
                        if m.sender:
                            sender_name = getattr(m.sender, "first_name", "") or ""
                            if hasattr(m.sender, "username") and m.sender.username:
                                sender_name = f"@{m.sender.username}"
                        recent_context.append(f"[{sender_name}]: {m.text[:200]}")

                chat_context_str = "\n".join(recent_context[-15:])

                # ── Filter for reply-worthy messages ───────────────────
                candidates = []
                for m in messages:
                    if not m.text or not m.text.strip():
                        continue
                    # Skip own messages
                    if m.sender_id and own_user_id and m.sender_id == own_user_id:
                        continue
                    # Skip already-replied messages
                    if (chat_id, m.id) in already_replied:
                        continue
                    # Only engage RECENT messages (≤20 min). Answering a message
                    # the conversation moved on from looks like "scrolling up" —
                    # when the chat goes quiet we'd rather initiate a fresh topic
                    # than dredge up something old.
                    if m.date:
                        msg_age = (
                            datetime.now(timezone.utc)
                            - m.date.replace(tzinfo=timezone.utc)
                        ).total_seconds()
                        if msg_age > 1200:  # 20 minutes
                            continue
                    # Skip only truly empty/1-char noise — keep greetings
                    # ("привет", "Всем привет") and short replies as candidates;
                    # the engage-brain decides relevance, not a length cutoff.
                    if len(m.text.strip()) < 2:
                        continue
                    # Forwarded messages WITH text are kept (e.g. someone forwards
                    # a crypto news post — a perfect on-topic hook). Only media-only
                    # forwards have no text and are already dropped above.
                    candidates.append(m)

                # Prioritize messages AIMED AT US (reply-to-us / @mention), then
                # questions, over just-the-newest line — so a direct @mention is
                # never starved by newer general chatter (only 1 reply per cycle).
                # Within a tier, newest first.
                our_ids = {
                    r["tg_message_id"] for r in db.execute(
                        "SELECT tg_message_id FROM tg_ai_messages "
                        "WHERE persona_id=? AND chat_id=? AND tg_message_id IS NOT NULL",
                        [persona_id, chat_id],
                    ).fetchall()
                }

                def _cand_priority(m: Any) -> tuple[int, int]:
                    d = _is_directed(m, own_username, our_ids)
                    q = "?" in (m.text or "")
                    tier = 0 if d else (1 if q else 2)
                    return (tier, -(m.id or 0))

                candidates.sort(key=_cand_priority)

                _log_activity(
                    db, persona_id, chat_id, chat_title, "SCAN",
                    f"Зашёл в чат «{chat_title}», прочитал {len(messages)} сообщений; "
                    f"подходящих для ответа: {len(candidates)}",
                    {"read": len(messages), "candidates": len(candidates)},
                )

                if not candidates:
                    # ── Quiet chat → maybe START a conversation ────────────
                    # Opt-in proactive initiation. Backoff is structural: we only
                    # initiate when the LAST message wasn't ours, so after one
                    # opener (last msg becomes ours) we won't post again until a
                    # real person talks — no self-talk, no spam. Plus a daily
                    # initiation budget and an "online" probability roll.
                    import random as _rnd
                    did_initiate = False
                    if bool(schedule.get("initiate_enabled", False)) and remaining_today > 0 and messages:
                        last_msg = messages[0]  # iter_messages is newest-first
                        last_from_us = bool(
                            last_msg.sender_id and own_user_id
                            and last_msg.sender_id == own_user_id
                        )
                        last_age = None
                        if last_msg.date:
                            last_age = (
                                datetime.now(timezone.utc)
                                - last_msg.date.replace(tzinfo=timezone.utc)
                            ).total_seconds()
                        sil_min = int(schedule.get("silence_min_min", 30))
                        sil_max = int(schedule.get("silence_max_min", 90))
                        sil_threshold = _rnd.uniform(
                            min(sil_min, sil_max), max(sil_min, sil_max)
                        ) * 60
                        init_row = db.execute(
                            "SELECT COUNT(*) AS c FROM tg_ai_messages "
                            "WHERE persona_id=? AND created_at>=? "
                            "AND reply_to_msg_id IS NULL AND status='SENT'",
                            [persona_id, today_start],
                        ).fetchone()
                        init_today = init_row["c"] if init_row else 0
                        init_per_day = int(schedule.get("initiations_per_day", 2))

                        # Two cases:
                        #  • others went quiet after talking → re-engage after the
                        #    normal silence window (last msg NOT ours).
                        #  • WE had the last word and nobody replied → REVIVE the
                        #    dead chat, but only after a much longer silence (so we
                        #    don't talk to ourselves), capped by the daily budget.
                        revive_threshold = max(sil_threshold * 3, 2700)  # ≥45 min
                        ready = last_age is not None and (
                            (not last_from_us and last_age >= sil_threshold)
                            or (last_from_us and last_age >= revive_threshold)
                        )
                        if (
                            ready
                            and init_today < init_per_day
                            and _rnd.random() < hcfg["online_chance"]
                        ):
                            opener, ocost = await _generate_opener(
                                persona, chat_title, chat_about, recent_context, model, temperature,
                                own_name=own_name, own_username=own_username,
                            )
                            if opener:
                                try:
                                    _delay = _rnd.uniform(hcfg["delay_min_sec"], hcfg["delay_max_sec"])
                                    await _human_pause(client, entity, _delay)
                                    sent_msg = await _resilient_send(client, entity, opener)
                                    tg_message_id = sent_msg.id if sent_msg else None
                                    total_cost_usd += ocost
                                    _track_ai_cost(db, ocost)
                                    db.execute("""
                                        INSERT INTO tg_ai_messages
                                            (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                             original_text, ai_text, ai_reasoning,
                                             status, sent_at, tg_message_id, created_at)
                                        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'SENT', ?, ?, ?)
                                    """, [
                                        str(uuid.uuid4()), persona_id, chat_id, chat_title,
                                        "", opener, f"initiation cost=${ocost:.4f}",
                                        _now(), tg_message_id, _now(),
                                    ])
                                    db.commit()
                                    remaining_today -= 1
                                    ch_result["sent"] += 1
                                    total_chat_replies += 1
                                    did_initiate = True
                                    _log_activity(
                                        db, persona_id, chat_id, chat_title, "SENT",
                                        f"💬 Сам начал разговор (тишина ~{int(last_age // 60)} мин): «{opener[:160]}»",
                                        {"initiation": True, "tg_message_id": tg_message_id},
                                    )
                                    log.info("ai_agent_initiated", persona_id=persona_id, chat=chat_title)
                                except (UserBannedInChannelError, ChatWriteForbiddenError):
                                    db.execute(
                                        "UPDATE tg_ai_personas SET status='PAUSED', updated_at=? WHERE id=?",
                                        [_now(), persona_id],
                                    )
                                    db.commit()
                                    _log_activity(
                                        db, persona_id, None, None, "SKIP",
                                        "⏸ Агент на ПАУЗЕ: не смог начать разговор — нет прав/бан в чате.",
                                    )
                                    notify_admin_pref(
                                        db, "spam_block",
                                        f"🚫 <b>Агент авто-пауза</b> (при попытке начать разговор)\n"
                                        f"Персона: {persona.get('name') or persona_id}\n"
                                        f"Чат: {chat_title or chat_id}"
                                    )
                                    log.warning("ai_agent_initiate_banned", chat=chat_title)
                                except Exception as _e:
                                    log.warning("ai_agent_initiate_failed", chat=chat_title, error=str(_e)[:120])

                    if not did_initiate:
                        _log_activity(
                            db, persona_id, chat_id, chat_title, "SKIP",
                            "Подходящих сообщений для ответа сейчас нет — жду новых",
                        )
                    channel_results.append(ch_result)
                    continue

                # ONE reply per cycle, newest reply-worthy message first. Pacing
                # between replies is the cycle interval (scan_interval_sec), NOT a
                # long in-cycle sleep — keeps each cycle short & robust so the
                # self-rescheduling loop can't die mid-sleep (previous bug: a 1-5
                # min in-cycle sleep got interrupted → loop never rescheduled).
                # `candidates` is built newest-first (from iter_messages).
                max_replies = min(1, remaining_today)
                selected = candidates[:max_replies]

                # ── HUMAN BEHAVIOUR GATE ───────────────────────────────
                # Decide like a person: am I "online" now? is this aimed at me?
                # do I bother replying? maybe just react with an emoji? This
                # probabilistic gate (not "answer everything every 3 min") is
                # what makes the agent feel alive and unpredictable.
                if not selected:
                    channel_results.append(ch_result)
                    continue
                import random as _rnd
                cand = selected[0]
                # our_ids already computed above for candidate prioritization.
                directed = _is_directed(cand, own_username, our_ids)
                # A direct question to the group deserves a text answer, not a
                # 👍 — treat it like a directed message (people expect a reply).
                is_question = "?" in (cand.text or "")
                # Online rhythm: sometimes "away" → stay silent this cycle. But a
                # direct question / @mention / reply to us is answered even when
                # we're "mostly away" (a real person glances and replies) — so the
                # away-roll only gates GENERAL chatter, not messages aimed at us.
                if not (directed or is_question) and _rnd.random() > hcfg["online_chance"]:
                    _log_activity(db, persona_id, chat_id, chat_title, "SKIP",
                                  "Сейчас «не в сети» — пропускаю общую болтовню")
                    channel_results.append(ch_result)
                    continue
                if directed or is_question:
                    # Aimed at us, or a question to the group → usually answer.
                    want_reply = _rnd.random() < hcfg["reply_chance_directed"]
                else:
                    # BRAIN: jump into the conversation like a normal friendly
                    # member would (questions, banter, topics we can add to) —
                    # not just our niche, but not every trivial line either.
                    engage, _why = await _should_engage(recent_context, persona, model)
                    if not engage:
                        _log_activity(db, persona_id, chat_id, chat_title, "THINK",
                                      "Прочитал переписку — сейчас отвечать не буду (нечего добавить)")
                        want_reply = False
                    else:
                        want_reply = _rnd.random() < max(hcfg["reply_chance_general"], 0.7)
                want_react = _rnd.random() < hcfg["reaction_chance"]
                # Emoji reaction is a light touch used ONLY when we weren't going
                # to reply anyway — never as a substitute for a reply we wanted to
                # send, and never on a question / message aimed at us (those always
                # get words; a 👍 to "идём?" looks like a bot that didn't read).
                if not is_question and not directed and not want_reply and want_react:
                    emoji = await _pick_reaction(cand.text or "", model)
                    if emoji and await _send_reaction(client, entity, cand.id, emoji):
                        _log_activity(db, persona_id, chat_id, chat_title, "SENT",
                                      f"Поставил реакцию {emoji}",
                                      {"reaction": emoji, "reply_to": cand.id})
                        already_replied.add((chat_id, cand.id))
                        channel_results.append(ch_result)
                        continue
                if not want_reply:
                    _log_activity(db, persona_id, chat_id, chat_title, "SKIP",
                                  "Решил промолчать (не на каждое сообщение нужно отвечать)")
                    channel_results.append(ch_result)
                    continue
                # else → proceed to a text reply (with human delay + typing below)

                # ── RAG context for chat ───────────────────────────────
                # Build a summary query from chat context for RAG
                rag_chunks = _search_kb_chunks(
                    db, rag_doc_ids, chat_about + " " + chat_context_str
                ) if rag_doc_ids else []
                rag_context = _build_rag_context(rag_chunks)

                if rag_chunks:
                    _log_activity(
                        db, persona_id, chat_id, chat_title, "KB",
                        f"Поднял из базы знаний {len(rag_chunks)} фрагм. для ответа",
                        {"chunks": len(rag_chunks)},
                    )
                _log_activity(
                    db, persona_id, chat_id, chat_title, "THINK",
                    f"Формулирую ответы на {len(selected)} сообщ. (модель {model})",
                    {"selected": len(selected)},
                )

                # ── Generate and send/save replies ─────────────────────
                system_prompt = _build_chat_system_prompt(
                    persona, rag_context, feedback_block,
                    own_name=own_name, own_username=own_username,
                ) + style_block

                for msg in selected:
                    if remaining_today <= 0:
                        break

                    # Budget re-check before each AI call
                    if not _check_ai_budget(db):
                        log.warning("ai_agent_budget_mid_run", persona_id=persona_id)
                        remaining_today = 0
                        break

                    msg_id = str(uuid.uuid4())
                    original_text = msg.text[:2000]

                    try:
                        # Generate AI reply
                        user_message = _build_chat_user_message(
                            chat_title, chat_about, recent_context, original_text
                        )
                        ai_result = generate_message(
                            system_prompt=system_prompt,
                            user_message=user_message,
                            model=model,
                            max_tokens=300,
                            temperature=temperature,
                        )

                        reply_text = _humanize_text(ai_result["text"].strip())
                        if not reply_text:
                            total_skipped += 1
                            continue

                        cost = ai_result["cost_usd"]
                        total_cost_usd += cost
                        _track_ai_cost(db, cost)

                        ai_reasoning = (
                            f"model={ai_result['model']}, "
                            f"tokens={ai_result['tokens_in']}+{ai_result['tokens_out']}, "
                            f"cost=${cost:.4f}"
                        )

                        ch_result["generated"] += 1

                        # ── AUTO mode: send immediately ────────────────
                        if approval_mode == "AUTO":
                            try:
                                # Human pause + "typing…" before sending (15s..min).
                                _delay = _rnd.uniform(hcfg["delay_min_sec"], hcfg["delay_max_sec"])
                                await _human_pause(client, entity, _delay)
                                # Quote (reply-to) only when answering an OLDER
                                # message — for the latest message in an active
                                # back-and-forth a real person just types, no
                                # quote. (DB still records msg.id for tracking.)
                                _is_latest = bool(messages) and msg.id == messages[0].id
                                _quote = (not _is_latest) or (_rnd.random() < 0.15)
                                sent_msg = await _resilient_send(
                                    client, entity, reply_text,
                                    reply_to=(msg.id if _quote else None),
                                )
                                tg_message_id = sent_msg.id if sent_msg else None

                                db.execute("""
                                    INSERT INTO tg_ai_messages
                                        (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                         original_text, ai_text, ai_reasoning,
                                         status, sent_at, tg_message_id, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)
                                """, [
                                    msg_id, persona_id, chat_id, chat_title, msg.id,
                                    original_text, reply_text, ai_reasoning,
                                    _now(), tg_message_id, _now(),
                                ])
                                db.commit()

                                total_chat_replies += 1
                                ch_result["sent"] += 1
                                remaining_today -= 1
                                already_replied.add((chat_id, msg.id))

                                _log_activity(
                                    db, persona_id, chat_id, chat_title, "SENT",
                                    f"Ответил: «{reply_text[:180]}»",
                                    {"reply_to": msg.id, "tg_message_id": tg_message_id},
                                )

                                log.info(
                                    "ai_agent_chat_reply_sent",
                                    persona_id=persona_id,
                                    chat=chat_title,
                                    reply_to=msg.id,
                                    model=ai_result["model"],
                                )

                            except ChatWriteForbiddenError:
                                db.execute("""
                                    INSERT INTO tg_ai_messages
                                        (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                         original_text, ai_text, ai_reasoning,
                                         status, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                                """, [
                                    msg_id, persona_id, chat_id, chat_title, msg.id,
                                    original_text, reply_text,
                                    f"{ai_reasoning} | error=CHAT_WRITE_FORBIDDEN",
                                    _now(),
                                ])
                                db.commit()
                                total_failed += 1
                                ch_result["errors"].append("CHAT_WRITE_FORBIDDEN")
                                _log_activity(
                                    db, persona_id, chat_id, chat_title, "ERROR",
                                    "Не смог ответить: нет прав на запись в этом чате "
                                    "(возможно, только для админов / новичкам нельзя писать)",
                                )
                                db.execute(
                                    "UPDATE tg_ai_personas SET status='PAUSED', updated_at=? WHERE id=?",
                                    [_now(), persona_id],
                                )
                                db.commit()
                                _log_activity(
                                    db, persona_id, None, None, "SKIP",
                                    "⏸ Агент на ПАУЗЕ: нет прав на запись в чате. "
                                    "Проверьте права аккаунта и запустите снова.",
                                )
                                notify_admin_pref(
                                    db, "spam_block",
                                    f"⏸ <b>Агент на паузе</b>\n"
                                    f"Персона: {persona.get('name') or persona_id}\n"
                                    f"Чат: {chat_title or chat_id}\n"
                                    f"Причина: нет прав на запись (CHAT_WRITE_FORBIDDEN)"
                                )
                                log.warning("ai_agent_write_forbidden", chat=chat_title)
                                break  # No point trying more in this channel

                            except UserBannedInChannelError:
                                db.execute("""
                                    INSERT INTO tg_ai_messages
                                        (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                         original_text, ai_text, ai_reasoning,
                                         status, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                                """, [
                                    msg_id, persona_id, chat_id, chat_title, msg.id,
                                    original_text, reply_text,
                                    f"{ai_reasoning} | error=USER_BANNED_IN_CHANNEL",
                                    _now(),
                                ])
                                db.commit()
                                total_failed += 1
                                ch_result["errors"].append("USER_BANNED_IN_CHANNEL")
                                _log_activity(
                                    db, persona_id, chat_id, chat_title, "ERROR",
                                    "Не смог отправить ответ: аккаунт ЗАБАНЕН/ограничен на запись "
                                    "в этом чате (USER_BANNED_IN_CHANNEL). Ответ был готов: "
                                    f"«{reply_text[:120]}»",
                                )
                                # Auto-pause: don't keep hammering a chat where we're
                                # banned (burns the account, spams errors). Operator
                                # unbans, then re-launches.
                                db.execute(
                                    "UPDATE tg_ai_personas SET status='PAUSED', updated_at=? WHERE id=?",
                                    [_now(), persona_id],
                                )
                                db.commit()
                                _log_activity(
                                    db, persona_id, None, None, "SKIP",
                                    "⏸ Агент на ПАУЗЕ: аккаунт забанен в чате. Разбаньте "
                                    "аккаунт в чате и запустите агента снова.",
                                )
                                notify_admin_pref(
                                    db, "spam_block",
                                    f"🚫 <b>Аккаунт забанен в чате</b> — агент на паузе\n"
                                    f"Персона: {persona.get('name') or persona_id}\n"
                                    f"Чат: {chat_title or chat_id}\n"
                                    f"Причина: USER_BANNED_IN_CHANNEL. Разбаньте аккаунт и запустите снова."
                                )
                                log.warning("ai_agent_banned_in_channel", chat=chat_title)
                                break

                            except FloodWaitError as e:
                                wait_seconds = e.seconds
                                log.warning("ai_agent_flood_wait", wait=wait_seconds, chat=chat_title)

                                # Save as PENDING to not lose the reply
                                db.execute("""
                                    INSERT INTO tg_ai_messages
                                        (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                         original_text, ai_text, ai_reasoning,
                                         status, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
                                """, [
                                    msg_id, persona_id, chat_id, chat_title, msg.id,
                                    original_text, reply_text,
                                    f"{ai_reasoning} | flood_wait={wait_seconds}s",
                                    _now(),
                                ])
                                db.commit()
                                total_chat_pending += 1

                                if wait_seconds > 300:
                                    db.execute(
                                        "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                        [_now(), acc_id],
                                    )
                                    db.commit()
                                    ch_result["errors"].append(f"FLOOD_WAIT_{wait_seconds}s")
                                    remaining_today = 0
                                    break
                                else:
                                    await asyncio.sleep(wait_seconds + 5)

                            except PeerFloodError:
                                db.execute(
                                    "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                    [_now(), acc_id],
                                )
                                db.commit()
                                total_failed += 1
                                ch_result["errors"].append("PEER_FLOOD")
                                log.error("ai_agent_peer_flood", account=acc_info["phone"])
                                remaining_today = 0
                                break

                            except Exception as e:
                                db.execute("""
                                    INSERT INTO tg_ai_messages
                                        (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                         original_text, ai_text, ai_reasoning,
                                         status, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)
                                """, [
                                    msg_id, persona_id, chat_id, chat_title, msg.id,
                                    original_text, reply_text,
                                    f"{ai_reasoning} | error={str(e)[:100]}",
                                    _now(),
                                ])
                                db.commit()
                                total_failed += 1
                                log.warning("ai_agent_send_error", chat=chat_title, error=str(e)[:100])

                        else:
                            # ── MANUAL mode: save as PENDING ───────────
                            db.execute("""
                                INSERT INTO tg_ai_messages
                                    (id, persona_id, chat_id, chat_title, reply_to_msg_id,
                                     original_text, ai_text, ai_reasoning,
                                     status, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
                            """, [
                                msg_id, persona_id, chat_id, chat_title, msg.id,
                                original_text, reply_text, ai_reasoning, _now(),
                            ])
                            db.commit()
                            total_chat_pending += 1
                            remaining_today -= 1
                            already_replied.add((chat_id, msg.id))

                            log.info(
                                "ai_agent_chat_reply_pending",
                                persona_id=persona_id,
                                chat=chat_title,
                                reply_to=msg.id,
                            )

                        # ── Interest detection for DM queue ────────────
                        if (
                            dm_enabled
                            and msg.sender_id
                            and msg.sender_id != own_user_id
                        ):
                            sender_username = ""
                            sender_name = ""
                            if msg.sender:
                                sender_username = getattr(msg.sender, "username", "") or ""
                                first = getattr(msg.sender, "first_name", "") or ""
                                last = getattr(msg.sender, "last_name", "") or ""
                                sender_name = f"{first} {last}".strip()

                            interest_score = _evaluate_interest(
                                user_text=original_text,
                                username=sender_username or str(msg.sender_id),
                                chat_context=chat_context_str,
                                model=model,
                                temperature=temperature,
                            )

                            if interest_score >= 7:
                                dm_queue.append({
                                    "user_id": msg.sender_id,
                                    "username": sender_username,
                                    "name": sender_name,
                                    "interest_score": interest_score,
                                    "topic": original_text[:200],
                                    "chat_title": chat_title,
                                    "chat_id": chat_id,
                                    "account_id": acc_id,
                                })
                                log.info(
                                    "ai_agent_interest_detected",
                                    user=sender_username or msg.sender_id,
                                    score=interest_score,
                                    chat=chat_title,
                                )

                    except Exception as e:
                        total_failed += 1
                        log.error(
                            "ai_agent_generate_error",
                            persona_id=persona_id,
                            chat=chat_title,
                            error=str(e)[:200],
                        )

                    # No long in-cycle sleep: only one reply per cycle, pacing is
                    # the cycle interval. Keeps the cycle short so the loop is robust.

            except Exception as e:
                ch_result["errors"].append(f"CHANNEL_ERROR: {str(e)[:100]}")
                log.error("ai_agent_channel_error", channel=channel_ref, error=str(e)[:200])

            channel_results.append(ch_result)

        # ═══════════════════════════════════════════════════════════════
        # PHASE B: DM Outreach (if dm_enabled)
        # ═══════════════════════════════════════════════════════════════

        if dm_enabled and dm_queue:
            # B1: Initiate new DMs for interesting users found in Phase A
            for dm_target in dm_queue:
                # Only process DM targets for this account
                if dm_target["account_id"] != acc_id:
                    continue

                contact_user_id = dm_target["user_id"]
                contact_username = dm_target["username"]
                contact_name = dm_target["name"]

                # Check if we already have a sales_dialog with this contact
                existing = db.execute(
                    "SELECT * FROM tg_sales_dialogs WHERE contact_user_id = ? AND account_id = ?",
                    [contact_user_id, acc_id],
                ).fetchone()

                if existing:
                    # Already tracking this contact -- skip new DM
                    log.info(
                        "ai_agent_dm_exists",
                        contact=contact_username or contact_user_id,
                        status=existing["lead_status"],
                    )
                    continue

                # Budget check
                if not _check_ai_budget(db):
                    log.warning("ai_agent_dm_budget_exceeded", persona_id=persona_id)
                    break

                # RAG context for DM
                topic = dm_target["topic"]
                rag_chunks = _search_kb_chunks(
                    db, rag_doc_ids, topic
                ) if rag_doc_ids else []
                rag_context = _build_rag_context(rag_chunks)

                # Generate opening DM
                dm_system = _build_dm_system_prompt(
                    persona,
                    chat_title=dm_target["chat_title"],
                    topic=topic[:100],
                    rag_context=rag_context,
                )

                dm_user_msg = (
                    f"You saw @{contact_username or contact_name}'s message "
                    f"in the chat '{dm_target['chat_title']}':\n\n"
                    f"\"{topic}\"\n\n"
                    "Write an opening DM to this person. Be natural, reference their "
                    "message/interest, and start a conversation. Keep it short (2-3 sentences)."
                )

                try:
                    ai_result = generate_message(
                        system_prompt=dm_system,
                        user_message=dm_user_msg,
                        model=model,
                        max_tokens=300,
                        temperature=temperature,
                    )

                    dm_text = ai_result["text"].strip()
                    if not dm_text:
                        continue

                    cost = ai_result["cost_usd"]
                    total_cost_usd += cost
                    _track_ai_cost(db, cost)

                    # Create sales dialog
                    dialog_id = str(uuid.uuid4())
                    db.execute("""
                        INSERT INTO tg_sales_dialogs
                            (id, account_id, script_id, contact_user_id,
                             contact_username, contact_name, current_stage,
                             lead_status, lead_score, messages_in, messages_out,
                             ai_summary, created_at, updated_at)
                        VALUES (?, ?, NULL, ?, ?, ?, 'intro', 'NEW', ?, 0, 0, ?, ?, ?)
                    """, [
                        dialog_id, acc_id, contact_user_id,
                        contact_username, contact_name,
                        float(dm_target["interest_score"]),
                        f"From chat: {dm_target['chat_title']}. Topic: {topic[:200]}",
                        _now(), _now(),
                    ])
                    db.commit()

                    # Send DM
                    try:
                        # Resolve user entity
                        dm_entity = None
                        if contact_username:
                            try:
                                dm_entity = await client.get_entity(f"@{contact_username}")
                            except Exception:
                                pass
                        if dm_entity is None:
                            dm_entity = await client.get_entity(contact_user_id)

                        await client.send_message(dm_entity, dm_text)

                        # Log to tg_sales_messages
                        out_msg_id = str(uuid.uuid4())
                        db.execute("""
                            INSERT INTO tg_sales_messages
                                (id, dialog_id, direction, text, stage, ai_model,
                                 tokens_in, tokens_out, cost_usd, created_at)
                            VALUES (?, ?, 'OUTBOUND', ?, 'intro', ?, ?, ?, ?, ?)
                        """, [
                            out_msg_id, dialog_id, dm_text, ai_result["model"],
                            ai_result["tokens_in"], ai_result["tokens_out"],
                            cost, _now(),
                        ])

                        # Update dialog counters
                        db.execute("""
                            UPDATE tg_sales_dialogs SET
                                messages_out = 1,
                                lead_status = 'ENGAGING',
                                last_message_at = ?,
                                updated_at = ?
                            WHERE id = ?
                        """, [_now(), _now(), dialog_id])
                        db.commit()

                        # Update persona total_dm_sent
                        db.execute(
                            "UPDATE tg_ai_personas SET total_dm_sent = total_dm_sent + 1, "
                            "total_leads = total_leads + 1, updated_at = ? WHERE id = ?",
                            [_now(), persona_id],
                        )
                        db.commit()

                        total_dm_sent += 1
                        log.info(
                            "ai_agent_dm_sent",
                            persona_id=persona_id,
                            contact=contact_username or contact_user_id,
                            interest=dm_target["interest_score"],
                        )

                    except UserPrivacyRestrictedError:
                        log.info(
                            "ai_agent_dm_privacy",
                            contact=contact_username or contact_user_id,
                        )
                        db.execute(
                            "UPDATE tg_sales_dialogs SET lead_status = 'LOST', "
                            "ai_summary = COALESCE(ai_summary, '') || ' | Privacy restricted', "
                            "updated_at = ? WHERE id = ?",
                            [_now(), dialog_id],
                        )
                        db.commit()
                        total_skipped += 1

                    except PeerFloodError:
                        log.error("ai_agent_dm_peer_flood", account=acc_info["phone"])
                        db.execute(
                            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                            [_now(), acc_id],
                        )
                        db.commit()
                        total_failed += 1
                        break  # Stop DMs for this account

                    except FloodWaitError as e:
                        log.warning("ai_agent_dm_flood_wait", wait=e.seconds)
                        if e.seconds > 300:
                            db.execute(
                                "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                [_now(), acc_id],
                            )
                            db.commit()
                            break
                        else:
                            await asyncio.sleep(e.seconds + 5)

                    except Exception as e:
                        log.warning(
                            "ai_agent_dm_send_error",
                            contact=contact_username or contact_user_id,
                            error=str(e)[:100],
                        )
                        total_failed += 1

                except Exception as e:
                    log.error(
                        "ai_agent_dm_generate_error",
                        contact=contact_username or contact_user_id,
                        error=str(e)[:200],
                    )
                    total_failed += 1

                # Anti-ban delay between DMs
                delay = random.uniform(30, 120)
                log.info("ai_agent_dm_sleeping", seconds=round(delay, 1))
                await asyncio.sleep(delay)

        # ═══════════════════════════════════════════════════════════════
        # PHASE B2: Check existing DM dialogs for unread messages
        # ═══════════════════════════════════════════════════════════════

        if dm_enabled:
            try:
                tg_dialogs = await client.get_dialogs(limit=30)

                for tg_dialog in tg_dialogs:
                    # Only process user DMs (not channels/groups)
                    if not tg_dialog.is_user:
                        continue
                    # Skip if no unread messages
                    if tg_dialog.unread_count == 0:
                        continue

                    user_entity = tg_dialog.entity
                    contact_user_id = user_entity.id
                    contact_username = getattr(user_entity, "username", None) or ""
                    _first = getattr(user_entity, "first_name", "") or ""
                    _last = getattr(user_entity, "last_name", "") or ""
                    contact_name = f"{_first} {_last}".strip()

                    # Per-thread state for the universal AI-secretary mode.
                    # Upsert happens even for sales-flow dialogs so the messenger
                    # UI can show a unified summary/mute toggle for any chat.
                    thread = _upsert_dm_thread(
                        db, acc_id, contact_user_id, contact_username, contact_name,
                    )

                    # Mute is a hard skip — operator chose silence for this peer.
                    if thread.get("muted"):
                        continue

                    # Check if we have a sales_dialog for this user (legacy
                    # cold-outreach lead). Sales-dialog flow has its own scripted
                    # stages and takes precedence over the universal secretary.
                    existing_dialog = db.execute(
                        "SELECT * FROM tg_sales_dialogs WHERE contact_user_id = ? AND account_id = ?",
                        [contact_user_id, acc_id],
                    ).fetchone()

                    if existing_dialog and dict(existing_dialog)["lead_status"] in _TERMINAL_STATUSES:
                        # Closed lead — leave it alone.
                        continue

                    # ── Universal AI-secretary branch ─────────────────────
                    # No sales_dialog AND dm_reply_to_all is on → handle as
                    # generic DM: read history, refresh summary, reply via RAG.
                    if not existing_dialog and dm_reply_to_all:
                        sec_res = await _handle_secretary_dm(
                            client=client, db=db,
                            persona=persona, persona_id=persona_id,
                            account_id=acc_id, model=model, temperature=temperature,
                            rag_doc_ids=rag_doc_ids,
                            user_entity=user_entity,
                            contact_user_id=contact_user_id,
                            contact_username=contact_username,
                            contact_name=contact_name,
                            thread=thread, hcfg=hcfg,
                            own_name=own_name, own_username=own_username,
                        )
                        total_dm_replied += sec_res.get("replied", 0)
                        total_failed += sec_res.get("failed", 0)
                        total_skipped += sec_res.get("skipped", 0)
                        total_cost_usd += sec_res.get("cost_usd", 0.0)
                        if sec_res.get("flood_break"):
                            # Account hit a long FloodWait — stop processing more
                            # DMs this cycle so we don't pile errors.
                            break
                        # Delay between DMs even in secretary mode (anti-ban).
                        await asyncio.sleep(random.uniform(30, 120))
                        continue
                    if not existing_dialog:
                        # dm_reply_to_all is OFF and not a known lead → skip,
                        # matches the old behaviour exactly.
                        continue

                    dialog = dict(existing_dialog)

                    # Budget check
                    if not _check_ai_budget(db):
                        break

                    # Read unread messages
                    unread_msgs = await client.get_messages(
                        user_entity, limit=tg_dialog.unread_count
                    )
                    unread_msgs = list(reversed(unread_msgs))

                    # Filter to only inbound text messages
                    inbound_texts = []
                    for um in unread_msgs:
                        if um.out or not um.text:
                            continue
                        inbound_texts.append(um.text)

                    if not inbound_texts:
                        continue

                    combined_inbound = "\n".join(inbound_texts)

                    # Save inbound messages
                    for text in inbound_texts:
                        in_msg_id = str(uuid.uuid4())
                        db.execute("""
                            INSERT INTO tg_sales_messages
                                (id, dialog_id, direction, text, stage, created_at)
                            VALUES (?, ?, 'INBOUND', ?, ?, ?)
                        """, [in_msg_id, dialog["id"], text, dialog["current_stage"], _now()])
                    db.execute(
                        "UPDATE tg_sales_dialogs SET messages_in = messages_in + ?, "
                        "last_message_at = ?, updated_at = ? WHERE id = ?",
                        [len(inbound_texts), _now(), _now(), dialog["id"]],
                    )
                    db.commit()

                    # RAG context for reply
                    rag_chunks = _search_kb_chunks(
                        db, rag_doc_ids, combined_inbound
                    ) if rag_doc_ids else []
                    rag_context = _build_rag_context(rag_chunks)

                    # Load conversation history
                    msg_rows = db.execute(
                        "SELECT direction, text FROM tg_sales_messages "
                        "WHERE dialog_id = ? ORDER BY created_at ASC",
                        [dialog["id"]],
                    ).fetchall()

                    conv_messages: list[dict[str, str]] = []
                    for row in msg_rows:
                        role = "assistant" if row["direction"] == "OUTBOUND" else "user"
                        conv_messages.append({"role": role, "content": row["text"]})

                    # Build system prompt using chat context from summary
                    dm_system = _build_dm_system_prompt(
                        persona,
                        chat_title=dialog.get("ai_summary", "").split("From chat: ")[-1].split(".")[0] if dialog.get("ai_summary") else "a group chat",
                        topic=dialog.get("ai_summary", "")[:100],
                        rag_context=rag_context,
                    )

                    try:
                        ai_result = generate_chat(
                            system_prompt=dm_system,
                            messages=conv_messages,
                            model=model,
                            max_tokens=512,
                            temperature=temperature,
                        )

                        reply_text = ai_result["text"].strip()
                        if not reply_text:
                            continue

                        cost = ai_result["cost_usd"]
                        total_cost_usd += cost
                        _track_ai_cost(db, cost)

                        # Save outbound message
                        out_msg_id = str(uuid.uuid4())
                        db.execute("""
                            INSERT INTO tg_sales_messages
                                (id, dialog_id, direction, text, stage, ai_model,
                                 tokens_in, tokens_out, cost_usd, created_at)
                            VALUES (?, ?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?)
                        """, [
                            out_msg_id, dialog["id"], reply_text,
                            dialog["current_stage"], ai_result["model"],
                            ai_result["tokens_in"], ai_result["tokens_out"],
                            cost, _now(),
                        ])
                        db.commit()

                        # Send reply
                        await client.send_message(user_entity, reply_text)

                        # Update dialog
                        db.execute("""
                            UPDATE tg_sales_dialogs SET
                                messages_out = messages_out + 1,
                                last_message_at = ?,
                                updated_at = ?
                            WHERE id = ?
                        """, [_now(), _now(), dialog["id"]])
                        db.commit()

                        total_dm_replied += 1
                        log.info(
                            "ai_agent_dm_reply_sent",
                            dialog_id=dialog["id"],
                            contact=contact_username or contact_user_id,
                            cost=cost,
                        )

                    except FloodWaitError as e:
                        log.warning("ai_agent_dm_reply_flood", wait=e.seconds)
                        if e.seconds > 300:
                            db.execute(
                                "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                [_now(), acc_id],
                            )
                            db.commit()
                            break
                        else:
                            await asyncio.sleep(e.seconds + 5)

                    except PeerFloodError:
                        db.execute(
                            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                            [_now(), acc_id],
                        )
                        db.commit()
                        total_failed += 1
                        break

                    except UserPrivacyRestrictedError:
                        log.info("ai_agent_dm_reply_privacy", contact=contact_username or contact_user_id)
                        total_skipped += 1

                    except Exception as e:
                        log.warning(
                            "ai_agent_dm_reply_error",
                            dialog_id=dialog["id"],
                            error=str(e)[:100],
                        )
                        total_failed += 1

                    # Mark as read
                    try:
                        await client.send_read_acknowledge(user_entity)
                    except Exception:
                        pass

                    # Anti-ban delay between DM replies
                    delay = random.uniform(30, 120)
                    await asyncio.sleep(delay)

            except Exception as e:
                log.error("ai_agent_dm_scan_error", account_id=acc_id, error=str(e)[:200])

        # ── Disconnect this account ────────────────────────────────────
        if client and tmp_dir:
            await _disconnect_client(client, tmp_dir)
            client = None
            tmp_dir = None

        log.info(
            "ai_agent_account_done",
            account=acc_info["phone"],
            chat_replies=total_chat_replies,
            dm_sent=total_dm_sent,
            dm_replied=total_dm_replied,
        )

    # ═══════════════════════════════════════════════════════════════════
    # Finalize: update persona counters + audit log
    # ═══════════════════════════════════════════════════════════════════

    total_messages = total_chat_replies + total_chat_pending + total_dm_sent + total_dm_replied
    if total_messages > 0:
        db.execute(
            "UPDATE tg_ai_personas SET total_messages = total_messages + ?, updated_at = ? WHERE id = ?",
            [total_chat_replies + total_chat_pending, _now(), persona_id],
        )
        db.commit()

    # Audit log
    db.execute("""
        INSERT INTO tg_audit_logs
            (event_type, severity, entity_type, entity_id, message, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, [
        "ai_agent.cycle_complete", "INFO", "ai_persona", persona_id,
        (
            f"AI agent cycle: {total_chat_replies} chat replies sent, "
            f"{total_chat_pending} pending, {total_dm_sent} DMs initiated, "
            f"{total_dm_replied} DM replies, {total_failed} failed, "
            f"{total_skipped} skipped, ${total_cost_usd:.4f} spent"
        ),
        json.dumps({
            "chat_replies_sent": total_chat_replies,
            "chat_replies_pending": total_chat_pending,
            "dm_initiated": total_dm_sent,
            "dm_replied": total_dm_replied,
            "failed": total_failed,
            "skipped": total_skipped,
            "cost_usd": round(total_cost_usd, 4),
            "channels": channel_results,
            "dm_queue_size": len(dm_queue),
        }),
        _now(),
    ])
    db.commit()

    result = {
        "status": "COMPLETED",
        "persona_id": persona_id,
        "chat_replies_sent": total_chat_replies,
        "chat_replies_pending": total_chat_pending,
        "dm_initiated": total_dm_sent,
        "dm_replied": total_dm_replied,
        "failed": total_failed,
        "skipped": total_skipped,
        "cost_usd": round(total_cost_usd, 4),
        "channels_processed": len(channel_results),
        "remaining_today": remaining_today,
    }
    log.info("ai_agent_cycle_complete", **result)
    return result
