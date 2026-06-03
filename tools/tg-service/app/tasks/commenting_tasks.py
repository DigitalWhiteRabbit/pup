"""Celery task for Neuro-Commenting — AI/template-based auto-commenting on target channels.

Connects to Telegram via Telethon using task accounts, monitors target
channels for recent posts, generates contextual comments using Claude AI
or picks from linked message templates, and either sends immediately
(AUTO mode) or saves as PENDING for manual approval.

Anti-ban: random delays between delay_min and delay_max, max_per_day cap
per account, 24h post age limit, FloodWait / ChatWriteForbidden /
UserBannedInChannel / SlowModeWait / ChannelPrivate handling.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
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


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    # P5-02: delegate to the shared builder (was duplicated across ~10 modules).
    from app.services.tg_runner import build_proxy_kwargs
    return build_proxy_kwargs(db, proxy_id)



def _connect_account(db: Any, account_id: str) -> dict[str, Any] | None:
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


def _matches_keywords(text: str, keywords_raw: str | None) -> bool:
    """Check if post text contains any of the trigger keywords (case-insensitive)."""
    if not keywords_raw or not text:
        return False
    text_lower = text.lower()
    keywords = [kw.strip().lower() for kw in keywords_raw.split(",") if kw.strip()]
    return any(kw in text_lower for kw in keywords)


def _get_today_comment_count(db: Any, task_id: str, account_id: str) -> int:
    """Count comments already sent today by this account for this task."""
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).isoformat()
    row = db.execute(
        """SELECT COUNT(*) AS cnt FROM tg_commenting_log
           WHERE task_id = ? AND account_id = ? AND status = 'SENT'
           AND created_at >= ?""",
        [task_id, account_id, today_start],
    ).fetchone()
    return row["cnt"] if row else 0


def _load_template_variants(db: Any, category: str = "COMMENT") -> list[str]:
    """Load template variants for the COMMENT category."""
    rows = db.execute(
        """SELECT v.text FROM tg_template_variants v
           JOIN tg_message_templates t ON v.template_id = t.id
           WHERE t.category = ? AND t.status = 'ACTIVE'
           ORDER BY v.position""",
        [category],
    ).fetchall()
    return [r["text"] for r in rows if r["text"]]


# ── Celery task ─────────────────────────────────────────────────────────────


@celery_app.task(name="pup_tg.commenting_task", bind=True, max_retries=0)
def commenting_task(self, workspace_id: str, task_id: str) -> dict:
    """Execute a commenting task — post comments on target channels."""
    return asyncio.run(_commenting_task_async(workspace_id, task_id))


async def _commenting_task_async(workspace_id: str, task_id: str) -> dict:
    db = get_db(workspace_id)
    now = _now()

    # ── Load task config ────────────────────────────────────────────────────
    task = db.execute(
        "SELECT * FROM tg_commenting_tasks WHERE id = ?", [task_id]
    ).fetchone()
    if not task:
        return {"status": "FAILED", "error": "Commenting task not found"}
    if task["status"] != "ACTIVE":
        return {"status": "SKIPPED", "error": f"Task status is {task['status']}, not ACTIVE"}

    mode = task["mode"] or "AI"
    trigger_type = task["trigger_type"] or "ALL_POSTS"
    trigger_keywords = task["trigger_keywords"]
    system_prompt = task["system_prompt"] or ""
    ai_model = _resolve_model(task["ai_model"])
    approval_mode = task["approval_mode"] or "AUTO"
    max_per_day = task["max_per_day"] or 10
    delay_min = task["delay_min"] or 60
    delay_max = task["delay_max"] or 600

    target_channels = json.loads(task["target_channels"] or "[]")
    account_ids = json.loads(task["account_ids"] or "[]")

    if trigger_type == "MANUAL":
        return {"status": "SKIPPED", "error": "MANUAL trigger — nothing to do automatically"}

    if not target_channels:
        db.execute(
            "UPDATE tg_commenting_tasks SET status='PAUSED', updated_at=? WHERE id=?",
            [now, task_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No target channels configured"}

    log.info(
        "commenting_task_started",
        task_id=task_id,
        workspace_id=workspace_id,
        mode=mode,
        channels=len(target_channels),
        accounts=len(account_ids),
    )

    # ── Pick accounts ───────────────────────────────────────────────────────
    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]
    if not account_ids:
        db.execute(
            "UPDATE tg_commenting_tasks SET status='PAUSED', updated_at=? WHERE id=?",
            [now, task_id],
        )
        db.commit()
        return {"status": "FAILED", "error": "No ACTIVE accounts available"}

    # ── Load template variants for TEMPLATES / MIXED mode ───────────────────
    template_variants: list[str] = []
    if mode in ("TEMPLATES", "MIXED"):
        template_variants = _load_template_variants(db, "COMMENT")
        if not template_variants and mode == "TEMPLATES":
            db.execute(
                "UPDATE tg_commenting_tasks SET status='PAUSED', updated_at=? WHERE id=?",
                [now, task_id],
            )
            db.commit()
            return {"status": "FAILED", "error": "No COMMENT template variants found for TEMPLATES mode"}

    # ── Default system prompt ───────────────────────────────────────────────
    if not system_prompt and mode in ("AI", "MIXED"):
        system_prompt = (
            "You are a real Telegram user. Write a short, natural comment on the post below. "
            "Be casual and authentic. Do NOT sound like an AI. Keep it 1-3 sentences max. "
            "Match the language of the post. Do not use hashtags or excessive emojis."
        )

    # ── Execute commenting ──────────────────────────────────────────────────
    total_sent = 0
    total_pending = 0
    total_failed = 0
    total_skipped = 0
    flood_blocks = 0
    comment_counter = 0  # for MIXED mode alternation

    for acc_id in account_ids:
        # Re-check task status (might have been stopped externally)
        task_check = db.execute(
            "SELECT status FROM tg_commenting_tasks WHERE id = ?", [task_id]
        ).fetchone()
        if task_check and task_check["status"] != "ACTIVE":
            log.info("commenting_task_externally_stopped", task_id=task_id)
            break

        acc_info = _connect_account(db, acc_id)
        if not acc_info:
            log.warning("commenting_account_skip", account_id=acc_id, reason="not active or missing credentials")
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, task_id=task_id)
            total_failed += 1
            continue

        # Check today's limit
        today_count = _get_today_comment_count(db, task_id, acc_id)
        if today_count >= max_per_day:
            log.info("commenting_daily_limit_reached", account_id=acc_id, count=today_count, limit=max_per_day)
            continue

        remaining_budget = max_per_day - today_count

        # Connect to Telegram
        tmp_dir = tempfile.mkdtemp(prefix="comm_")
        tmp_session = Path(tmp_dir) / "comm.session"
        tmp_session.write_bytes(acc_info["session_bytes"])

        from telethon import TelegramClient
        from telethon.errors import (
            FloodWaitError,
            ChatWriteForbiddenError,
            UserBannedInChannelError,
            SlowModeWaitError,
            ChannelPrivateError,
            AuthKeyUnregisteredError,
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
                    log.warning("commenting_auth_failed", account_id=acc_id)
                    continue
        except AuthKeyUnregisteredError:
            db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?", [_now(), acc_id])
            db.commit()
            log.error("commenting_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [_now(), _now(), acc_id],
            )
            db.commit()
            log.error("commenting_account_banned", account_id=acc_id)
            flood_blocks += 1
            continue
        except Exception as e:
            log.error("commenting_connect_error", account_id=acc_id, error=str(e)[:100])
            continue

        log.info("commenting_account_connected", account_id=acc_id, phone=acc_info["phone"])

        sent_this_account = 0
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

        for channel_ref in target_channels:
            if sent_this_account >= remaining_budget:
                break

            # Re-check task status
            task_check2 = db.execute(
                "SELECT status FROM tg_commenting_tasks WHERE id = ?", [task_id]
            ).fetchone()
            if task_check2 and task_check2["status"] != "ACTIVE":
                break

            try:
                # Resolve channel entity
                try:
                    channel_entity = await client.get_entity(channel_ref)
                except Exception as e:
                    log.warning(
                        "commenting_channel_resolve_failed",
                        channel=channel_ref,
                        error=str(e)[:100],
                    )
                    continue

                channel_id = str(getattr(channel_entity, "id", channel_ref))
                channel_title = getattr(channel_entity, "title", channel_ref) or channel_ref

                # Fetch recent posts
                posts = []
                async for msg in client.iter_messages(channel_entity, limit=20):
                    if msg.date and msg.date.replace(tzinfo=timezone.utc) < cutoff:
                        break
                    if not msg.text:
                        continue
                    posts.append(msg)

                if not posts:
                    log.info("commenting_no_posts", channel=channel_title)
                    continue

                # Filter posts by trigger
                eligible_posts = []
                for post in posts:
                    if trigger_type == "KEYWORDS":
                        if not _matches_keywords(post.text, trigger_keywords):
                            continue

                    # Check if already commented on this post by this account
                    existing = db.execute(
                        """SELECT id FROM tg_commenting_log
                           WHERE task_id = ? AND account_id = ? AND channel_id = ? AND post_id = ?
                           AND status IN ('SENT', 'PENDING')""",
                        [task_id, acc_id, channel_id, post.id],
                    ).fetchone()
                    if existing:
                        continue

                    eligible_posts.append(post)

                if not eligible_posts:
                    log.info("commenting_no_eligible_posts", channel=channel_title)
                    continue

                # Process eligible posts
                for post in eligible_posts:
                    if sent_this_account >= remaining_budget:
                        break

                    comment_text = ""
                    ai_model_used = None
                    tokens_in = 0
                    tokens_out = 0
                    cost_usd = 0.0
                    log_id = str(uuid.uuid4())

                    # Generate comment based on mode
                    try:
                        if mode == "AI" or (mode == "MIXED" and (comment_counter % 2 == 0 or not template_variants)):
                            # AI-generated comment
                            from app.ai.anthropic_client import generate_message

                            user_msg = f"Channel: {channel_title}\n\nPost:\n{post.text[:2000]}"
                            ai_result = generate_message(
                                system_prompt=system_prompt,
                                user_message=user_msg,
                                model=ai_model,
                                max_tokens=256,
                                temperature=0.8,
                            )
                            comment_text = ai_result["text"].strip()
                            ai_model_used = ai_result["model"]
                            tokens_in = ai_result["tokens_in"]
                            tokens_out = ai_result["tokens_out"]
                            cost_usd = ai_result["cost_usd"]

                        elif mode == "TEMPLATES" or (mode == "MIXED" and template_variants):
                            # Template-based comment
                            comment_text = random.choice(template_variants)

                        comment_counter += 1

                    except Exception as e:
                        log.error(
                            "commenting_generate_failed",
                            channel=channel_title,
                            post_id=post.id,
                            error=str(e)[:200],
                        )
                        # Log as failed
                        db.execute(
                            """INSERT INTO tg_commenting_log
                                (id, task_id, account_id, channel_id, channel_title, post_id,
                                 post_text, comment_text, status, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)""",
                            [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                             (post.text or "")[:2000], f"[GENERATION ERROR] {str(e)[:200]}", _now()],
                        )
                        db.commit()
                        total_failed += 1
                        continue

                    if not comment_text:
                        total_skipped += 1
                        continue

                    # Decide: send or save as pending
                    if approval_mode == "AUTO":
                        # Send immediately
                        try:
                            sent_msg = await client.send_message(
                                channel_entity, comment_text, comment_to=post.id
                            )
                            tg_message_id = sent_msg.id if sent_msg else None

                            db.execute(
                                """INSERT INTO tg_commenting_log
                                    (id, task_id, account_id, channel_id, channel_title, post_id,
                                     post_text, comment_text, ai_model, tokens_in, tokens_out,
                                     cost_usd, status, tg_message_id, sent_at, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)""",
                                [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                                 (post.text or "")[:2000], comment_text, ai_model_used,
                                 tokens_in, tokens_out, cost_usd,
                                 tg_message_id, _now(), _now()],
                            )
                            db.commit()

                            total_sent += 1
                            sent_this_account += 1

                            # Update task counter
                            db.execute(
                                """UPDATE tg_commenting_tasks
                                   SET total_comments = total_comments + 1, updated_at = ?
                                   WHERE id = ?""",
                                [_now(), task_id],
                            )
                            db.commit()

                            log.info(
                                "commenting_sent",
                                account=acc_info["phone"],
                                channel=channel_title,
                                post_id=post.id,
                                mode="AI" if ai_model_used else "TEMPLATE",
                            )

                        except ChatWriteForbiddenError:
                            db.execute(
                                """INSERT INTO tg_commenting_log
                                    (id, task_id, account_id, channel_id, channel_title, post_id,
                                     post_text, comment_text, ai_model, tokens_in, tokens_out,
                                     cost_usd, status, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)""",
                                [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                                 (post.text or "")[:2000], comment_text, ai_model_used,
                                 tokens_in, tokens_out, cost_usd, _now()],
                            )
                            db.commit()
                            total_failed += 1
                            log.warning(
                                "commenting_write_forbidden",
                                channel=channel_title,
                                account=acc_info["phone"],
                            )
                            break  # skip this channel for this account

                        except UserBannedInChannelError:
                            db.execute(
                                """INSERT INTO tg_commenting_log
                                    (id, task_id, account_id, channel_id, channel_title, post_id,
                                     post_text, comment_text, ai_model, tokens_in, tokens_out,
                                     cost_usd, status, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)""",
                                [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                                 (post.text or "")[:2000], comment_text, ai_model_used,
                                 tokens_in, tokens_out, cost_usd, _now()],
                            )
                            db.commit()
                            total_failed += 1
                            flood_blocks += 1
                            log.error(
                                "commenting_banned_in_channel",
                                channel=channel_title,
                                account=acc_info["phone"],
                            )
                            break  # skip this channel for this account

                        except SlowModeWaitError as e:
                            wait_seconds = e.seconds
                            log.warning(
                                "commenting_slow_mode",
                                channel=channel_title,
                                wait=wait_seconds,
                            )
                            if wait_seconds <= 300:
                                await asyncio.sleep(wait_seconds + 5)
                                # Retry on next iteration (don't mark as sent)
                                total_skipped += 1
                            else:
                                # Too long — save as pending instead
                                db.execute(
                                    """INSERT INTO tg_commenting_log
                                        (id, task_id, account_id, channel_id, channel_title, post_id,
                                         post_text, comment_text, ai_model, tokens_in, tokens_out,
                                         cost_usd, status, created_at)
                                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)""",
                                    [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                                     (post.text or "")[:2000], comment_text, ai_model_used,
                                     tokens_in, tokens_out, cost_usd, _now()],
                                )
                                db.commit()
                                total_pending += 1
                                break  # skip channel for now

                        except FloodWaitError as e:
                            wait_seconds = e.seconds
                            log.warning(
                                "commenting_flood_wait",
                                account=acc_info["phone"],
                                wait=wait_seconds,
                            )
                            if wait_seconds > 300:
                                db.execute(
                                    "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                    [_now(), acc_id],
                                )
                                db.commit()
                                total_failed += 1
                                break  # move to next account
                            else:
                                await asyncio.sleep(wait_seconds + 5)
                                total_skipped += 1

                        except ChannelPrivateError:
                            log.warning(
                                "commenting_channel_private",
                                channel=channel_title,
                            )
                            total_skipped += 1
                            break  # skip this channel

                        except Exception as e:
                            db.execute(
                                """INSERT INTO tg_commenting_log
                                    (id, task_id, account_id, channel_id, channel_title, post_id,
                                     post_text, comment_text, ai_model, tokens_in, tokens_out,
                                     cost_usd, status, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?)""",
                                [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                                 (post.text or "")[:2000], comment_text, ai_model_used,
                                 tokens_in, tokens_out, cost_usd, _now()],
                            )
                            db.commit()
                            total_failed += 1
                            log.warning(
                                "commenting_send_error",
                                channel=channel_title,
                                post_id=post.id,
                                error=str(e)[:100],
                            )

                    else:
                        # approval_mode == ALL or IMPORTANT — save as PENDING
                        db.execute(
                            """INSERT INTO tg_commenting_log
                                (id, task_id, account_id, channel_id, channel_title, post_id,
                                 post_text, comment_text, ai_model, tokens_in, tokens_out,
                                 cost_usd, status, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)""",
                            [log_id, task_id, acc_id, channel_id, channel_title, post.id,
                             (post.text or "")[:2000], comment_text, ai_model_used,
                             tokens_in, tokens_out, cost_usd, _now()],
                        )
                        db.commit()
                        total_pending += 1
                        log.info(
                            "commenting_pending",
                            channel=channel_title,
                            post_id=post.id,
                            approval_mode=approval_mode,
                        )

                    # Anti-ban: random delay between comments
                    delay = random.uniform(delay_min, delay_max)
                    log.info("commenting_sleeping", seconds=round(delay, 1))
                    await asyncio.sleep(delay)

            except ChannelPrivateError:
                log.warning("commenting_channel_private", channel=channel_ref)
                continue
            except Exception as e:
                log.error(
                    "commenting_channel_error",
                    channel=channel_ref,
                    error=str(e)[:200],
                )
                continue

        # Disconnect this account
        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        log.info(
            "commenting_account_done",
            account=acc_info["phone"],
            sent=sent_this_account,
            total_sent=total_sent,
        )

    # ── Finalize task ───────────────────────────────────────────────────────
    # Keep ACTIVE so Celery Beat can re-trigger on next schedule
    db.execute(
        "UPDATE tg_commenting_tasks SET updated_at = ? WHERE id = ?",
        [_now(), task_id],
    )
    db.commit()

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "commenting_task.complete",
            "INFO",
            "commenting_task",
            task_id,
            f"Commenting complete: {total_sent} sent, {total_pending} pending, {total_failed} failed, {total_skipped} skipped",
            json.dumps({
                "sent": total_sent,
                "pending": total_pending,
                "failed": total_failed,
                "skipped": total_skipped,
                "flood_blocks": flood_blocks,
            }),
            _now(),
        ],
    )
    db.commit()

    result = {
        "status": "COMPLETED",
        "sent": total_sent,
        "pending": total_pending,
        "failed": total_failed,
        "skipped": total_skipped,
        "flood_blocks": flood_blocks,
    }
    log.info("commenting_task_complete", task_id=task_id, **result)
    return result
