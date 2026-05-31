"""Celery task for AI Promoter — autonomous chat monitoring and reply generation.

Connects to Telegram via Telethon using the persona's linked account,
monitors target channels for messages worth replying to, generates
contextual replies using Claude, and either sends immediately (AUTO mode)
or saves as PENDING for manual approval.

Anti-ban: random delays 60-600s between replies, active hours enforcement,
daily message caps, FloodWait / ChatWriteForbidden / ChannelPrivate handling.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
import uuid
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any

import structlog

from app.config import settings
from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# ── Model name normalisation ────────────────────────────────────────────────
# The UI stores short names like "claude-haiku-4-5", but the Anthropic API
# requires full model IDs.  This map covers the models we ship with.
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


# ── Schedule helpers ────────────────────────────────────────────────────────

def _parse_active_hours(schedule: dict[str, Any]) -> tuple[time, time] | None:
    """Parse active_hours from schedule JSON, e.g. '09:00-22:00'.

    Returns (start_time, end_time) or None if not configured.
    """
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


# ── Account connection (mirrors dm_campaign_tasks pattern) ──────────────────

def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    import python_socks
    proxy_row = db.execute("SELECT * FROM tg_proxies WHERE id = ?", [proxy_id]).fetchone()
    if not proxy_row or proxy_row["status"] != "ACTIVE":
        return {}
    scheme = (proxy_row["scheme"] or "http").lower()
    if "socks5" in scheme:
        ptype = python_socks.ProxyType.SOCKS5
    elif "socks4" in scheme:
        ptype = python_socks.ProxyType.SOCKS4
    else:
        ptype = python_socks.ProxyType.HTTP
    return {
        "proxy": {
            "proxy_type": ptype,
            "addr": proxy_row["host"],
            "port": int(proxy_row["port"]),
            "username": proxy_row["username"],
            "password": proxy_row["password"],
            "rdns": True,
        }
    }


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


# ── System prompt builder ───────────────────────────────────────────────────

def _build_system_prompt(persona: dict[str, Any]) -> str:
    """Build the full system prompt from persona fields + base instructions.

    The persona's custom system_prompt is appended at the end so it can
    override defaults while still receiving structural context.
    """
    parts: list[str] = [
        "You are an AI persona participating in Telegram group chats.",
        "Your goal is to contribute meaningfully to conversations, build"
        " credibility, and subtly promote relevant topics when appropriate.",
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
            "Strategy: SOFT — Be naturally helpful, share knowledge, build trust."
            " Never hard-sell. Promotion should be invisible and organic."
            " Focus on providing value first."
        ),
        "medium": (
            "Strategy: MEDIUM — Balance helpfulness with subtle promotion."
            " You can mention relevant products/services when contextually"
            " appropriate. Be conversational but gently guide interest."
        ),
        "aggressive": (
            "Strategy: AGGRESSIVE — Actively promote when opportunities arise."
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
    ])

    # Append custom system prompt
    custom = (persona.get("system_prompt") or "").strip()
    if custom:
        parts.extend(["", "Additional instructions:", custom])

    return "\n".join(parts)


def _build_user_message(
    original_text: str,
    chat_title: str,
    recent_context: list[str],
) -> str:
    """Build the user message sent to Claude for reply generation."""
    lines = [f"Chat: {chat_title}", ""]
    if recent_context:
        lines.append("Recent messages in the conversation:")
        for ctx in recent_context[-10:]:  # Last 10 for context
            lines.append(f"  {ctx}")
        lines.append("")
    lines.append(f"Message to reply to:\n{original_text}")
    lines.append("")
    lines.append(
        "Generate a single natural reply to the above message."
        " Reply with ONLY the message text, no explanations or metadata."
    )
    return "\n".join(lines)


# ── Celery task ─────────────────────────────────────────────────────────────

@celery_app.task(name="pup_tg.ai_promoter", bind=True, max_retries=0)
def ai_promoter(self, workspace_id: str, persona_id: str) -> dict:
    """Execute one AI promoter cycle for a persona — scan channels, generate replies."""
    return asyncio.run(_ai_promoter_async(workspace_id, persona_id))


async def _ai_promoter_async(workspace_id: str, persona_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # ── Load persona ────────────────────────────────────────────────────
    persona = db.execute(
        "SELECT * FROM tg_ai_personas WHERE id = ?", [persona_id]
    ).fetchone()
    if not persona:
        return {"status": "FAILED", "error": "Persona not found"}
    if persona["status"] != "ACTIVE":
        return {"status": "SKIPPED", "error": f"Persona status is {persona['status']}, not ACTIVE"}

    persona_dict = dict(persona)
    schedule = json.loads(persona_dict.get("schedule") or "{}")
    target_channels = json.loads(persona_dict.get("target_channels") or "[]")

    if not target_channels:
        return {"status": "SKIPPED", "error": "No target channels configured"}

    # ── Active hours check ──────────────────────────────────────────────
    if not _is_within_active_hours(schedule):
        log.info("promoter_outside_hours", persona_id=persona_id)
        return {"status": "SKIPPED", "error": "Outside active hours"}

    # ── Daily limit check ───────────────────────────────────────────────
    max_per_day = _get_max_messages_day(schedule)
    today_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    sent_today_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_ai_messages WHERE persona_id = ? AND created_at >= ?",
        [persona_id, today_start],
    ).fetchone()
    sent_today = sent_today_row["cnt"] if sent_today_row else 0
    remaining_today = max(0, max_per_day - sent_today)

    if remaining_today <= 0:
        log.info("promoter_daily_limit", persona_id=persona_id, limit=max_per_day)
        return {"status": "SKIPPED", "error": f"Daily limit reached ({max_per_day})"}

    # ── Load account ────────────────────────────────────────────────────
    account_id = persona_dict.get("account_id")
    if not account_id:
        return {"status": "FAILED", "error": "No account linked to persona"}

    acc_info = _connect_account_info(db, account_id)
    if not acc_info:
        log.warning("promoter_account_unavailable", persona_id=persona_id, account_id=account_id)
        return {"status": "FAILED", "error": "Account not active or missing credentials"}

    # NO_PROXY guard: never connect a proxy-less account over the real IP.
    if "proxy" not in acc_info["proxy_kwargs"]:
        log.warning("no_proxy_skip", account_id=account_id, persona_id=persona_id)
        return {"status": "FAILED", "error": "NO_PROXY: нет активного прокси"}

    # ── Connect to Telegram ─────────────────────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="promoter_")
    tmp_session = Path(tmp_dir) / "promoter.session"
    tmp_session.write_bytes(acc_info["session_bytes"])

    from telethon import TelegramClient
    from telethon.errors import (
        AuthKeyUnregisteredError,
        ChannelPrivateError,
        ChatWriteForbiddenError,
        FloodWaitError,
        UserBannedInChannelError,
        UserDeactivatedBanError,
    )

    client = TelegramClient(
        str(tmp_session.with_suffix("")),
        acc_info["app_id"],
        acc_info["app_hash"],
        timeout=30,
        connection_retries=3,
        **acc_info["proxy_kwargs"],
    )

    try:
        await client.connect()
        if not await client.is_user_authorized():
            if acc_info["twofa"]:
                await client.sign_in(password=str(acc_info["twofa"]))
            else:
                log.warning("promoter_auth_failed", account_id=account_id)
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return {"status": "FAILED", "error": "Account auth failed"}
    except AuthKeyUnregisteredError:
        db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                   [_now(), account_id])
        db.commit()
        log.error("promoter_account_dead", account_id=account_id)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"status": "FAILED", "error": "Account auth key unregistered (DEAD)"}
    except UserDeactivatedBanError:
        db.execute("UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                   [_now(), _now(), account_id])
        db.commit()
        log.error("promoter_account_banned", account_id=account_id)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"status": "FAILED", "error": "Account banned by Telegram"}
    except Exception as e:
        log.error("promoter_connect_error", account_id=account_id, error=str(e)[:200])
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"status": "FAILED", "error": f"Connection error: {str(e)[:100]}"}

    log.info("promoter_connected", persona_id=persona_id, account=acc_info["phone"])

    # ── Get own user ID for skipping own messages ───────────────────────
    own_user_id = acc_info.get("tg_user_id")
    if not own_user_id:
        try:
            me = await client.get_me()
            own_user_id = me.id if me else None
        except Exception:
            pass

    # ── AI client ───────────────────────────────────────────────────────
    from app.ai.anthropic_client import generate_message

    system_prompt = _build_system_prompt(persona_dict)
    model = _resolve_model(persona_dict.get("ai_model"))
    temperature = persona_dict.get("temperature") or 0.8

    # Determine approval mode from schedule config
    approval_mode = schedule.get("approval_mode", "AUTO").upper()

    # ── Process channels ────────────────────────────────────────────────
    total_generated = 0
    total_sent = 0
    total_pending = 0
    total_failed = 0
    total_skipped = 0
    channel_results: list[dict[str, Any]] = []

    # Already-replied message IDs for this persona (avoid double-reply)
    replied_rows = db.execute(
        "SELECT reply_to_msg_id, chat_id FROM tg_ai_messages WHERE persona_id = ? AND status IN ('SENT', 'PENDING', 'APPROVED')",
        [persona_id],
    ).fetchall()
    already_replied: set[tuple[str, int]] = set()
    for r in replied_rows:
        if r["reply_to_msg_id"] and r["chat_id"]:
            already_replied.add((str(r["chat_id"]), int(r["reply_to_msg_id"])))

    for channel_ref in target_channels:
        if remaining_today <= 0:
            log.info("promoter_daily_cap_hit", persona_id=persona_id)
            break

        channel_result: dict[str, Any] = {"channel": channel_ref, "generated": 0, "sent": 0, "errors": []}

        try:
            # ── Resolve channel entity ──────────────────────────────────
            try:
                entity = await client.get_entity(channel_ref)
            except ChannelPrivateError:
                channel_result["errors"].append("CHANNEL_PRIVATE")
                channel_results.append(channel_result)
                log.warning("promoter_channel_private", channel=channel_ref)
                continue
            except Exception as e:
                channel_result["errors"].append(f"RESOLVE_ERROR: {str(e)[:80]}")
                channel_results.append(channel_result)
                log.warning("promoter_channel_resolve_error", channel=channel_ref, error=str(e)[:100])
                continue

            chat_id = str(entity.id)
            chat_title = getattr(entity, "title", channel_ref) or channel_ref

            # ── Fetch recent messages ───────────────────────────────────
            messages = []
            try:
                async for msg in client.iter_messages(entity, limit=20):
                    messages.append(msg)
            except ChannelPrivateError:
                channel_result["errors"].append("CHANNEL_PRIVATE")
                channel_results.append(channel_result)
                continue
            except Exception as e:
                channel_result["errors"].append(f"FETCH_ERROR: {str(e)[:80]}")
                channel_results.append(channel_result)
                log.warning("promoter_fetch_error", channel=channel_ref, error=str(e)[:100])
                continue

            if not messages:
                channel_results.append(channel_result)
                continue

            # ── Build context from recent messages ──────────────────────
            recent_context: list[str] = []
            for m in reversed(messages):
                if m.text:
                    sender_name = ""
                    if m.sender:
                        sender_name = getattr(m.sender, "first_name", "") or ""
                        if hasattr(m.sender, "username") and m.sender.username:
                            sender_name = f"@{m.sender.username}"
                    recent_context.append(f"[{sender_name}]: {m.text[:200]}")

            # ── Filter for reply-worthy messages ────────────────────────
            candidates = []
            for m in messages:
                # Skip messages without text
                if not m.text or not m.text.strip():
                    continue
                # Skip own messages
                if m.sender_id and own_user_id and m.sender_id == own_user_id:
                    continue
                # Skip already-replied messages
                if (chat_id, m.id) in already_replied:
                    continue
                # Skip messages older than 2 hours
                if m.date:
                    msg_age = (datetime.now(timezone.utc) - m.date.replace(tzinfo=timezone.utc)).total_seconds()
                    if msg_age > 7200:  # 2 hours
                        continue
                # Skip very short messages (less than 10 chars)
                if len(m.text.strip()) < 10:
                    continue
                # Skip service messages / forwarded
                if m.fwd_from:
                    continue
                candidates.append(m)

            if not candidates:
                channel_results.append(channel_result)
                continue

            # Pick a random subset to avoid replying to every message
            max_replies_per_channel = min(3, remaining_today)
            selected = random.sample(candidates, min(len(candidates), max_replies_per_channel))

            # ── Generate and send/save replies ──────────────────────────
            for msg in selected:
                if remaining_today <= 0:
                    break

                msg_id = str(uuid.uuid4())
                original_text = msg.text[:2000]  # Cap at 2000 chars

                try:
                    # Generate AI reply
                    user_message = _build_user_message(original_text, chat_title, recent_context)
                    ai_result = generate_message(
                        system_prompt=system_prompt,
                        user_message=user_message,
                        model=model,
                        max_tokens=300,
                        temperature=temperature,
                    )

                    reply_text = ai_result["text"].strip()
                    if not reply_text:
                        total_skipped += 1
                        continue

                    ai_reasoning = (
                        f"model={ai_result['model']}, "
                        f"tokens={ai_result['tokens_in']}+{ai_result['tokens_out']}, "
                        f"cost=${ai_result['cost_usd']:.4f}"
                    )

                    total_generated += 1
                    channel_result["generated"] += 1

                    # ── AUTO mode: send immediately ─────────────────────
                    if approval_mode == "AUTO":
                        try:
                            sent_msg = await client.send_message(
                                entity, reply_text, reply_to=msg.id
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

                            total_sent += 1
                            channel_result["sent"] += 1
                            remaining_today -= 1

                            # Track in already_replied to avoid double-reply within this run
                            already_replied.add((chat_id, msg.id))

                            log.info(
                                "promoter_reply_sent",
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
                            channel_result["errors"].append("CHAT_WRITE_FORBIDDEN")
                            log.warning("promoter_write_forbidden", chat=chat_title)
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
                            channel_result["errors"].append("USER_BANNED_IN_CHANNEL")
                            log.warning("promoter_banned_in_channel", chat=chat_title)
                            break

                        except FloodWaitError as e:
                            wait_seconds = e.seconds
                            log.warning("promoter_flood_wait", wait=wait_seconds, chat=chat_title)

                            # Save as PENDING instead of losing the generated reply
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
                            total_pending += 1

                            if wait_seconds > 300:
                                # Long wait -- pause account and abort
                                db.execute(
                                    "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                    [_now(), account_id],
                                )
                                db.commit()
                                channel_result["errors"].append(f"FLOOD_WAIT_{wait_seconds}s")
                                # Break out of all channels
                                remaining_today = 0
                                break
                            else:
                                await asyncio.sleep(wait_seconds + 5)

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
                            log.warning("promoter_send_error", chat=chat_title, error=str(e)[:100])

                    else:
                        # ── MANUAL / approval mode: save as PENDING ─────
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
                        total_pending += 1
                        remaining_today -= 1
                        already_replied.add((chat_id, msg.id))

                        log.info(
                            "promoter_reply_pending",
                            persona_id=persona_id,
                            chat=chat_title,
                            reply_to=msg.id,
                        )

                except Exception as e:
                    total_failed += 1
                    log.error(
                        "promoter_generate_error",
                        persona_id=persona_id,
                        chat=chat_title,
                        error=str(e)[:200],
                    )

                # ── Anti-ban delay between replies ──────────────────────
                delay = random.uniform(60, 600)
                log.info("promoter_sleeping", seconds=round(delay, 1))
                await asyncio.sleep(delay)

        except Exception as e:
            channel_result["errors"].append(f"CHANNEL_ERROR: {str(e)[:100]}")
            log.error("promoter_channel_error", channel=channel_ref, error=str(e)[:200])

        channel_results.append(channel_result)

    # ── Disconnect ──────────────────────────────────────────────────────
    try:
        await client.disconnect()
    except Exception:
        pass
    shutil.rmtree(tmp_dir, ignore_errors=True)

    # ── Update persona counters ─────────────────────────────────────────
    if total_sent > 0 or total_pending > 0:
        db.execute(
            "UPDATE tg_ai_personas SET total_messages = total_messages + ?, updated_at = ? WHERE id = ?",
            [total_sent + total_pending, _now(), persona_id],
        )
        db.commit()

    # ── Audit log ───────────────────────────────────────────────────────
    db.execute("""
        INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, [
        "ai_promoter.cycle_complete", "INFO", "ai_persona", persona_id,
        (
            f"AI promoter cycle: {total_generated} generated, "
            f"{total_sent} sent, {total_pending} pending, "
            f"{total_failed} failed, {total_skipped} skipped"
        ),
        json.dumps({
            "generated": total_generated,
            "sent": total_sent,
            "pending": total_pending,
            "failed": total_failed,
            "skipped": total_skipped,
            "channels": channel_results,
        }),
        _now(),
    ])
    db.commit()

    result = {
        "status": "COMPLETED",
        "persona_id": persona_id,
        "generated": total_generated,
        "sent": total_sent,
        "pending": total_pending,
        "failed": total_failed,
        "skipped": total_skipped,
        "channels_processed": len(channel_results),
        "remaining_today": remaining_today,
    }
    log.info("promoter_cycle_complete", **result)
    return result
