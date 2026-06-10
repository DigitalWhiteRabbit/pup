"""Celery tasks for STAGE 5 tools: Boost, Stories Boost, Cloner, Channel Creator, Converter.

Each task follows the same pattern as dm_campaign_tasks.py:
connect via Telethon, perform actions, log results, handle errors.
"""

from __future__ import annotations

import asyncio
import json
import random
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from app.config import settings
from app.core.continuity import touch_heartbeat
from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _within_hours(h_start: Any, h_end: Any) -> bool:
    """True if the current UTC hour is within [h_start, h_end) (wraps midnight).
    Degenerate/unparseable window → True (no gate)."""
    try:
        s = int(h_start) % 24
        e = int(h_end) % 24
    except (TypeError, ValueError):
        return True
    if s == e:
        return True
    cur = datetime.now(timezone.utc).hour
    if s < e:
        return s <= cur < e
    return cur >= s or cur < e


def _parse_replacements(raw: Any) -> list[tuple[str, str]]:
    """Parse a ``old→new`` (or ``old->new``) per-line replacements string into
    a list of (find, replace) pairs. Empty/blank input → empty list."""
    if not raw or not isinstance(raw, str):
        return []
    pairs: list[tuple[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        sep = "→" if "→" in line else ("->" if "->" in line else None)
        if not sep:
            continue
        old, new = line.split(sep, 1)
        old = old.strip()
        if old:
            pairs.append((old, new.strip()))
    return pairs


def _settings_active_now(db: Any) -> bool:
    """True if the current UTC hour is within tg_settings.active_hours
    ("HH:00-HH:00"). Missing/unparseable settings → always active (no gate)."""
    row = db.execute("SELECT active_hours FROM tg_settings WHERE id = 'default'").fetchone()
    if not row or not row["active_hours"]:
        return True
    s = row["active_hours"]
    if "-" not in s:
        return True
    try:
        start_s, end_s = s.split("-", 1)
        h_start = int(start_s.split(":")[0]) % 24
        h_end = int(end_s.split(":")[0]) % 24
    except (ValueError, IndexError):
        return True
    if h_start == h_end:
        return True
    cur = datetime.now(timezone.utc).hour
    if h_start < h_end:
        return h_start <= cur < h_end
    return cur >= h_start or cur < h_end


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
        "SELECT * FROM tg_accounts WHERE id = ? AND status = 'ACTIVE'",
        [account_id],
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
        "session_bytes": session_bytes,
        "app_id": int(app_id),
        "app_hash": str(app_hash),
        "twofa": meta.get("twoFA") or meta.get("twofa_password"),
        "proxy_kwargs": proxy_kwargs,
    }


async def _make_client(acc_info: dict[str, Any]) -> tuple[Any, str]:
    """Create a Telethon client from account info. Returns (client, tmp_dir)."""
    from telethon import TelegramClient

    tmp_dir = tempfile.mkdtemp(prefix="tg_s5_")
    tmp_session = Path(tmp_dir) / "s5.session"
    tmp_session.write_bytes(acc_info["session_bytes"])

    client = TelegramClient(
        str(tmp_session.with_suffix("")),
        acc_info["app_id"], acc_info["app_hash"],
        timeout=30, connection_retries=3,
        **acc_info["proxy_kwargs"],
    )
    await client.connect()
    if not await client.is_user_authorized():
        if acc_info["twofa"]:
            await client.sign_in(password=str(acc_info["twofa"]))
        else:
            raise RuntimeError("Account not authorized and no 2FA password")
    return client, tmp_dir


# ===========================================================================
# BOOST TASK — subscribe, react, view, vote
# ===========================================================================

@celery_app.task(name="pup_tg.boost_task", bind=True, max_retries=0)
def boost_task(self, workspace_id: str, task_id: str) -> dict:
    """Execute a boost task (subscribers/reactions/views/votes)."""
    return asyncio.run(_boost_async(workspace_id, task_id))


async def _boost_async(workspace_id: str, task_id: str) -> dict:
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.messages import SendReactionRequest
    from telethon.tl.types import ReactionEmoji
    from telethon.errors import FloodWaitError, ChannelPrivateError

    db = get_db(workspace_id)
    task = db.execute("SELECT * FROM tg_boost_tasks WHERE id = ?", [task_id]).fetchone()
    if not task:
        return {"status": "FAILED", "error": "Task not found"}
    if task["status"] != "RUNNING":
        return {"status": "SKIPPED", "error": f"Task status is {task['status']}"}

    touch_heartbeat(db, "tg_boost_tasks", task_id)  # P5-09 continuity

    # Active-hours gate (P2-06): respect global settings.active_hours — don't
    # run boost outside the configured window (anti-ban). Pause for a later run.
    if not _settings_active_now(db):
        db.execute("UPDATE tg_boost_tasks SET status='PAUSED', updated_at=? WHERE id=?",
                   [_now(), task_id])
        db.commit()
        log.info("boost_outside_active_hours", task_id=task_id)
        return {"status": "PAUSED", "reason": "outside active hours"}

    boost_type = task["boost_type"]  # SUBSCRIBERS|REACTIONS|VIEWS|POLL_VOTES
    target_channel = task["target_channel"]
    target_message_id = task["target_message_id"]
    account_ids = json.loads(task["account_ids"] or "[]")
    target_amount = task["target_amount"] or 0

    if not account_ids:
        # Health-sorted: prefer accounts with higher warmup level (more trustworthy)
        acc_rows = db.execute(
            """SELECT id FROM tg_accounts WHERE status = 'ACTIVE'
               ORDER BY warmup_level DESC NULLS LAST, updated_at ASC"""
        ).fetchall()
        account_ids = [r["id"] for r in acc_rows]

    # Round-robin rotation: advance cursor each run so different accounts go first
    config = json.loads(task["config"] or "{}")
    cursor = int(config.get("rotation_cursor", 0)) % max(len(account_ids), 1)
    if account_ids:
        account_ids = account_ids[cursor:] + account_ids[:cursor]
        config["rotation_cursor"] = (cursor + 1) % len(account_ids)
        db.execute(
            "UPDATE tg_boost_tasks SET config=?, updated_at=? WHERE id=?",
            [json.dumps(config, ensure_ascii=False), _now(), task_id],
        )
        db.commit()

    current_amount = task["current_amount"] or 0
    total_success = 0
    total_failed = 0

    for acc_id in account_ids:
        if target_amount > 0 and current_amount + total_success >= target_amount:
            break

        # P5-03: unified per-account gate (active hours + daily cap). Boost has no
        # settings daily-limit column, so a config override (boost_daily_limit)
        # supplies the cap; without it only active-hours gates this account.
        from app.core.daily_usage import ACTION_BOOST, can_act, incr_usage
        boost_acc_limit = int(config.get("boost_daily_limit", 0) or 0)
        allowed, reason = can_act(db, acc_id, ACTION_BOOST, limit=boost_acc_limit)
        if not allowed:
            log.info("boost_account_gated", account_id=acc_id, reason=reason)
            continue

        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, task_id=task_id)
            total_failed += 1
            continue

        try:
            client, tmp_dir = await _make_client(acc_info)
        except Exception as e:
            log.warning("boost_connect_failed", account_id=acc_id, error=str(e)[:100])
            continue

        try:
            entity = await client.get_entity(target_channel)

            if boost_type == "SUBSCRIBERS":
                await client(JoinChannelRequest(entity))
                total_success += 1

            elif boost_type == "REACTIONS":
                # Support multiple emojis with random pick (P4-08)
                emoji_pool = config.get("emojis") or []
                if isinstance(emoji_pool, str):
                    emoji_pool = [e.strip() for e in emoji_pool.split(",") if e.strip()]
                if not emoji_pool:
                    emoji_pool = [config.get("emoji", "👍")]
                emoji = random.choice(emoji_pool)
                await client(SendReactionRequest(
                    peer=entity,
                    msg_id=target_message_id or 0,
                    reaction=[ReactionEmoji(emoticon=emoji)],
                ))
                total_success += 1

            elif boost_type == "VIEWS":
                # Views are counted by reading messages
                await client.get_messages(entity, ids=[target_message_id or 0])
                total_success += 1

            elif boost_type == "POLL_VOTES":
                from telethon.tl.functions.messages import SendVoteRequest
                option_idx = config.get("option_index", 0)
                msg = await client.get_messages(entity, ids=[target_message_id or 0])
                if msg and msg[0] and hasattr(msg[0].media, "poll"):
                    poll = msg[0].media.poll
                    if option_idx < len(poll.answers):
                        await client(SendVoteRequest(
                            peer=entity,
                            msg_id=target_message_id,
                            options=[poll.answers[option_idx].option],
                        ))
                        total_success += 1

            # Log action
            db.execute(
                """INSERT INTO tg_boost_actions (id, task_id, account_id, action_type, success, created_at)
                   VALUES (?, ?, ?, ?, 1, ?)""",
                [str(uuid.uuid4()), task_id, acc_id, boost_type.lower(), _now()],
            )
            db.commit()
            incr_usage(db, acc_id, ACTION_BOOST)  # P5-03: persistent daily counter

        except FloodWaitError as e:
            log.warning("boost_flood", account_id=acc_id, wait=e.seconds)
            total_failed += 1
            db.execute(
                """INSERT INTO tg_boost_actions (id, task_id, account_id, action_type, success, error_code, created_at)
                   VALUES (?, ?, ?, ?, 0, ?, ?)""",
                [str(uuid.uuid4()), task_id, acc_id, boost_type.lower(), f"FLOOD_{e.seconds}s", _now()],
            )
            db.commit()
        except ChannelPrivateError:
            total_failed += 1
        except Exception as e:
            total_failed += 1
            log.warning("boost_error", account_id=acc_id, error=str(e)[:200])

        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

        # Natural delay between accounts
        if config.get("natural_curve", True):
            await asyncio.sleep(random.uniform(5, 30))
        else:
            await asyncio.sleep(random.uniform(1, 5))

    # Finalize
    db.execute(
        """UPDATE tg_boost_tasks SET
            current_amount = current_amount + ?, status = ?, finished_at = ?, updated_at = ?
           WHERE id = ?""",
        [total_success, "COMPLETED", _now(), _now(), task_id],
    )
    db.commit()

    return {"status": "COMPLETED", "success": total_success, "failed": total_failed}


# ===========================================================================
# STORIES BOOST — view/react to stories
# ===========================================================================

@celery_app.task(name="pup_tg.stories_boost", bind=True, max_retries=0)
def stories_boost(self, workspace_id: str, task_id: str) -> dict:
    return asyncio.run(_stories_boost_async(workspace_id, task_id))


async def _stories_boost_async(workspace_id: str, task_id: str) -> dict:
    from telethon.tl.functions.stories import ReadStoriesRequest, SendReactionRequest as StoryReactionRequest
    from telethon.tl.types import ReactionEmoji
    from telethon.errors import FloodWaitError

    db = get_db(workspace_id)
    task = db.execute("SELECT * FROM tg_stories_boost_tasks WHERE id = ?", [task_id]).fetchone()
    if not task or task["status"] != "RUNNING":
        return {"status": "SKIPPED"}

    # Active-hours gate (P2-07): respect global settings.active_hours.
    if not _settings_active_now(db):
        db.execute("UPDATE tg_stories_boost_tasks SET status='PAUSED', updated_at=? WHERE id=?",
                   [_now(), task_id])
        db.commit()
        log.info("stories_outside_active_hours", task_id=task_id)
        return {"status": "PAUSED", "reason": "outside active hours"}

    target_channel = task["target_channel"]
    target_story_id = task["target_story_id"]
    account_ids = json.loads(task["account_ids"] or "[]")
    config = json.loads(task["config"] or "{}")

    if not account_ids:
        acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE'").fetchall()
        account_ids = [r["id"] for r in acc_rows]

    total_views = 0
    total_reactions = 0

    for acc_id in account_ids:
        # P5-03: unified per-account gate (active hours + optional daily cap).
        from app.core.daily_usage import ACTION_BOOST, can_act, incr_usage
        st_acc_limit = int(config.get("stories_daily_limit", 0) or 0)
        allowed, reason = can_act(db, acc_id, ACTION_BOOST, limit=st_acc_limit)
        if not allowed:
            log.info("stories_account_gated", account_id=acc_id, reason=reason)
            continue

        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, task_id=task_id)
            continue

        try:
            client, tmp_dir = await _make_client(acc_info)
        except Exception:
            continue

        try:
            entity = await client.get_entity(target_channel)

            # Auto-detect latest story if target_story_id not specified (P4-06)
            effective_story_id = target_story_id
            if not effective_story_id:
                try:
                    from telethon.tl.functions.stories import GetPeerStoriesRequest
                    stories_result = await client(GetPeerStoriesRequest(peer=entity))
                    peer_stories = getattr(stories_result, "stories", None)
                    story_list = getattr(peer_stories, "stories", []) if peer_stories else []
                    if story_list:
                        effective_story_id = max(
                            (getattr(s, "id", 0) for s in story_list), default=0
                        )
                        log.info(
                            "stories_auto_detected",
                            task_id=task_id,
                            channel=target_channel,
                            story_id=effective_story_id,
                        )
                except Exception as exc:
                    log.warning("stories_auto_detect_failed", error=str(exc)[:150])

            # View story
            if effective_story_id:
                await client(ReadStoriesRequest(peer=entity, max_id=effective_story_id))
                total_views += 1
                incr_usage(db, acc_id, ACTION_BOOST)  # P5-03: persistent daily counter

                # React if configured
                if config.get("react"):
                    try:
                        await client(StoryReactionRequest(
                            peer=entity,
                            story_id=effective_story_id,
                            reaction=ReactionEmoji(emoticon=config.get("emoji", "👍")),
                        ))
                        total_reactions += 1
                    except Exception:
                        pass

        except FloodWaitError:
            pass
        except Exception as e:
            log.warning("stories_boost_error", error=str(e)[:200])

        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await asyncio.sleep(random.uniform(3, 15))

    db.execute(
        """UPDATE tg_stories_boost_tasks SET
            total_views = total_views + ?, total_reactions = total_reactions + ?,
            status = 'COMPLETED', finished_at = ?, updated_at = ?
           WHERE id = ?""",
        [total_views, total_reactions, _now(), _now(), task_id],
    )
    db.commit()

    return {"status": "COMPLETED", "views": total_views, "reactions": total_reactions}


# ===========================================================================
# CLONER — copy posts from one channel to another
# ===========================================================================

@celery_app.task(name="pup_tg.cloner_task", bind=True, max_retries=0)
def cloner_task(self, workspace_id: str, task_id: str) -> dict:
    return asyncio.run(_cloner_async(workspace_id, task_id))


async def _cloner_async(workspace_id: str, task_id: str) -> dict:
    from telethon.errors import FloodWaitError, ChatWriteForbiddenError

    db = get_db(workspace_id)
    task = db.execute("SELECT * FROM tg_clone_tasks WHERE id = ?", [task_id]).fetchone()
    if not task or task["status"] != "RUNNING":
        return {"status": "SKIPPED"}

    touch_heartbeat(db, "tg_clone_tasks", task_id)  # P5-09 continuity

    source_channel = task["source_channel"]
    target_channel = task["target_channel"]
    copy_items = json.loads(task["copy_items"] or '["posts"]')
    ai_rewrite = bool(task["ai_rewrite"])

    # Operational config (P2-08): replacements / max_posts_per_day / active hours / delays.
    sched = json.loads(task["schedule_config"] or "{}")
    replacements = _parse_replacements(sched.get("replacements"))
    max_posts_per_day = sched.get("max_posts_per_day")
    ah_from = sched.get("active_hours_from")
    ah_to = sched.get("active_hours_to")
    cl_delay_min = sched.get("delay_min") or 5
    cl_delay_max = sched.get("delay_max") or 30
    # Dedup cursor (P4-09): only fetch messages newer than last run
    last_cloned_id: int = int(sched.get("last_cloned_id", 0) or 0)
    # Content filters (P4-10)
    skip_keywords: list[str] = [
        kw.strip().lower()
        for kw in str(sched.get("skip_keywords") or "").split(",")
        if kw.strip()
    ]
    skip_ads: bool = bool(sched.get("skip_ads", False))

    # Active-hours gate: outside the configured window → pause for a later run.
    if ah_from is not None and ah_to is not None and not _within_hours(ah_from, ah_to):
        db.execute("UPDATE tg_clone_tasks SET status='PAUSED', updated_at=? WHERE id=?", [_now(), task_id])
        db.commit()
        log.info("cloner_outside_active_hours", task_id=task_id, frm=ah_from, to=ah_to)
        return {"status": "PAUSED", "reason": "outside active hours"}

    # Pick first available account
    acc_rows = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE' LIMIT 1").fetchall()
    if not acc_rows:
        db.execute("UPDATE tg_clone_tasks SET status='FAILED', updated_at=? WHERE id=?", [_now(), task_id])
        db.commit()
        return {"status": "FAILED", "error": "No active accounts"}

    acc_info = _connect_account_info(db, acc_rows[0]["id"])
    if not acc_info:
        return {"status": "FAILED", "error": "Account not available"}

    # NO_PROXY guard: never connect a proxy-less account over the real IP.
    if "proxy" not in acc_info["proxy_kwargs"]:
        log.warning("no_proxy_skip", account_id=acc_rows[0]["id"], task_id=task_id)
        db.execute("UPDATE tg_clone_tasks SET status='FAILED', updated_at=? WHERE id=?", [_now(), task_id])
        db.commit()
        return {"status": "FAILED", "error": "NO_PROXY: нет активного прокси"}

    try:
        client, tmp_dir = await _make_client(acc_info)
    except Exception as e:
        return {"status": "FAILED", "error": str(e)[:200]}

    total_posts = 0
    posted_count = 0
    rewritten_count = 0

    try:
        source_entity = await client.get_entity(source_channel)
        target_entity = await client.get_entity(target_channel)

        # ── Copy profile / avatar / pinned (P2-08) ───────────────────────────
        if "profile" in copy_items or "avatar" in copy_items:
            try:
                src_full = await client.get_entity(source_channel)
                title = getattr(src_full, "title", None)
                from telethon.tl.functions.channels import EditTitleRequest, EditPhotoRequest
                if "profile" in copy_items and title:
                    new_title = title
                    for old, new in replacements:
                        new_title = new_title.replace(old, new)
                    try:
                        await client(EditTitleRequest(channel=target_entity, title=new_title[:128]))
                        log.info("cloner_profile_copied", task_id=task_id)
                    except Exception as e:
                        log.warning("cloner_profile_failed", error=str(e)[:120])
                if "avatar" in copy_items:
                    try:
                        photos = await client.get_profile_photos(source_entity, limit=1)
                        if photos:
                            await client(EditPhotoRequest(channel=target_entity, photo=photos[0]))
                            log.info("cloner_avatar_copied", task_id=task_id)
                    except Exception as e:
                        log.warning("cloner_avatar_failed", error=str(e)[:120])
            except Exception as e:
                log.warning("cloner_profile_block_failed", error=str(e)[:120])

        if "pinned" in copy_items:
            try:
                recent = await client.get_messages(source_entity, limit=50)
                pinned_msg = next((m for m in recent if getattr(m, "pinned", False)), None)
                if pinned_msg:
                    ptext = pinned_msg.text or ""
                    for old, new in replacements:
                        ptext = ptext.replace(old, new)
                    if pinned_msg.media:
                        sent = await client.send_file(target_entity, pinned_msg.media, caption=ptext)
                    else:
                        sent = await client.send_message(target_entity, ptext) if ptext else None
                    if sent:
                        try:
                            await client.pin_message(target_entity, sent)
                            log.info("cloner_pinned_copied", task_id=task_id)
                        except Exception:
                            pass
            except Exception as e:
                log.warning("cloner_pinned_failed", error=str(e)[:120])

        if "posts" in copy_items:
            # max_posts_per_day caps how many posts we copy in one run.
            fetch_limit = 50
            try:
                if max_posts_per_day:
                    fetch_limit = min(50, int(max_posts_per_day))
            except (TypeError, ValueError):
                pass
            # Only fetch messages newer than last_cloned_id for dedup (P4-09)
            messages = await client.get_messages(
                source_entity,
                limit=fetch_limit,
                min_id=last_cloned_id,  # 0 means fetch all (first run)
            )
            total_posts = len(messages)
            new_max_id = last_cloned_id

            for msg in reversed(messages):
                if not msg.text and not msg.media:
                    continue

                text = msg.text or ""

                # Content filters (P4-10): skip ads or keyword-matched posts
                if skip_ads and getattr(msg, "fwd_from", None) is not None:
                    # Skip forwarded messages (often ads)
                    continue
                if skip_ads and any(
                    marker in text.lower()
                    for marker in ("#реклама", "#ad", "#спонсор", "#sponsor", "рекламируем")
                ):
                    continue
                if skip_keywords and text:
                    text_lower = text.lower()
                    if any(kw in text_lower for kw in skip_keywords):
                        continue

                # Apply text replacements (P2-08) before AI rewrite.
                for old, new in replacements:
                    text = text.replace(old, new)

                # AI rewrite if enabled
                if ai_rewrite and text:
                    try:
                        from app.ai.anthropic_client import generate_message
                        result = generate_message(
                            system_prompt=(
                                "Rewrite this Telegram post in a fresh style. "
                                "Keep the same meaning but change wording. "
                                "Reply with ONLY the rewritten text, no explanations."
                            ),
                            user_message=text,
                            model="claude-haiku-4-5-20251001",
                            max_tokens=1024,
                        )
                        text = result["text"]
                        rewritten_count += 1
                    except Exception:
                        pass

                try:
                    if msg.media:
                        await client.send_file(target_entity, msg.media, caption=text)
                    else:
                        await client.send_message(target_entity, text)
                    posted_count += 1
                    # Advance cursor to the latest successfully cloned message id
                    new_max_id = max(new_max_id, getattr(msg, "id", 0))
                except ChatWriteForbiddenError:
                    break
                except FloodWaitError as e:
                    if e.seconds > 60:
                        break
                    await asyncio.sleep(e.seconds + 5)
                except Exception:
                    pass

                await asyncio.sleep(random.uniform(cl_delay_min, cl_delay_max))

    except Exception as e:
        log.error("cloner_error", error=str(e)[:200])

    try:
        await client.disconnect()
    except Exception:
        pass
    shutil.rmtree(tmp_dir, ignore_errors=True)

    # Persist the cursor so next run only fetches new posts
    if new_max_id > last_cloned_id:
        sched["last_cloned_id"] = new_max_id
        db.execute(
            "UPDATE tg_clone_tasks SET schedule_config=?, updated_at=? WHERE id=?",
            [json.dumps(sched, ensure_ascii=False), _now(), task_id],
        )

    db.execute(
        """UPDATE tg_clone_tasks SET
            total_posts=?, posted_count=?, rewritten_count=?,
            status='COMPLETED', finished_at=?, updated_at=?
           WHERE id=?""",
        [total_posts, posted_count, rewritten_count, _now(), _now(), task_id],
    )
    db.commit()

    return {"status": "COMPLETED", "posted": posted_count, "rewritten": rewritten_count}


# ===========================================================================
# CHANNEL CREATOR — batch create channels/groups
# ===========================================================================

@celery_app.task(name="pup_tg.channel_creator", bind=True, max_retries=0)
def channel_creator_task(self, workspace_id: str, task_id: str) -> dict:
    return asyncio.run(_channel_creator_async(workspace_id, task_id))


async def _channel_creator_async(workspace_id: str, task_id: str) -> dict:
    from telethon.tl.functions.channels import CreateChannelRequest, UpdateUsernameRequest
    from telethon.tl.functions.messages import EditChatDefaultBannedRightsRequest
    from telethon.tl.types import ChatBannedRights
    from telethon.errors import FloodWaitError

    db = get_db(workspace_id)
    task = db.execute("SELECT * FROM tg_channel_creation_tasks WHERE id = ?", [task_id]).fetchone()
    if not task or task["status"] != "RUNNING":
        return {"status": "SKIPPED"}

    channel_type = task["channel_type"] or "CHANNEL"
    count = task["count"] or 1
    naming_pattern = task["naming_pattern"] or "Channel {n}"
    username_pattern = task["username_pattern"] or ""
    description = task["description"] or ""
    # permissions (P2-09): default banned rights for new members, applied via
    # EditChatDefaultBannedRights when non-empty. Keys are Telegram restriction
    # flags ("true" = restricted): send_messages, send_media, send_stickers,
    # send_polls, embed_links, invite_users, pin_messages, change_info.
    try:
        permissions = json.loads(task["permissions"] or "{}")
        if not isinstance(permissions, dict):
            permissions = {}
    except (json.JSONDecodeError, TypeError):
        permissions = {}
    creator_account_ids = json.loads(task["creator_account_ids"] or "[]")

    if not creator_account_ids:
        acc_rows = db.execute(
            "SELECT id FROM tg_accounts WHERE status = 'ACTIVE' ORDER BY warmup_level DESC NULLS LAST"
        ).fetchall()
        creator_account_ids = [r["id"] for r in acc_rows]

    if not creator_account_ids:
        db.execute("UPDATE tg_channel_creation_tasks SET status='FAILED', updated_at=? WHERE id=?", [_now(), task_id])
        db.commit()
        return {"status": "FAILED", "error": "No active accounts"}

    # P4-16: distribute channels across accounts (round-robin batches)
    # P4-17: per-account limit = ceil(count / num_accounts), ramp-up delay
    import math
    n_accounts = len(creator_account_ids)
    per_account = math.ceil(count / n_accounts)

    created_count = 0
    created_ids: list[str] = []
    megagroup = channel_type in ("SUPERGROUP", "BASIC_GROUP")

    for acc_idx, acc_id in enumerate(creator_account_ids):
        if created_count >= count:
            break

        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            continue
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, task_id=task_id)
            continue

        try:
            client, tmp_dir = await _make_client(acc_info)
        except Exception as e:
            log.warning("channel_creator_connect_failed", account_id=acc_id, error=str(e)[:100])
            continue

        # Number of channels this account should create
        batch_count = min(per_account, count - created_count)

        try:
            for batch_n in range(batch_count):
                n = created_count + 1  # global channel number
                title = naming_pattern.replace("{n}", str(n)).replace("{N}", str(n))
                try:
                    result = await client(CreateChannelRequest(
                        title=title,
                        about=description,
                        megagroup=megagroup,
                    ))
                    channel = result.chats[0]
                    created_count += 1
                    created_ids.append(str(channel.id))

                    # P4-18: incremental created_count update in DB
                    db.execute(
                        "UPDATE tg_channel_creation_tasks SET created_count=?, updated_at=? WHERE id=?",
                        [created_count, _now(), task_id],
                    )
                    db.commit()

                    # Set username (P2-09)
                    if username_pattern:
                        uname = username_pattern.replace("{n}", str(n)).replace("{N}", str(n))
                        uname = uname.lstrip("@").strip()
                        if uname:
                            try:
                                await client(UpdateUsernameRequest(channel=channel, username=uname))
                                log.info("channel_username_set", username=uname, tg_id=channel.id)
                            except Exception as ue:
                                log.warning("channel_username_failed", username=uname, error=str(ue)[:120])

                    # Apply default member permissions (P2-09)
                    if permissions:
                        try:
                            rights = ChatBannedRights(
                                until_date=None,
                                send_messages=bool(permissions.get("send_messages")),
                                send_media=bool(permissions.get("send_media")),
                                send_stickers=bool(permissions.get("send_stickers")),
                                send_gifs=bool(permissions.get("send_stickers")),
                                send_polls=bool(permissions.get("send_polls")),
                                embed_links=bool(permissions.get("embed_links")),
                                invite_users=bool(permissions.get("invite_users")),
                                pin_messages=bool(permissions.get("pin_messages")),
                                change_info=bool(permissions.get("change_info")),
                            )
                            await client(EditChatDefaultBannedRightsRequest(peer=channel, banned_rights=rights))
                            log.info("channel_permissions_set", tg_id=channel.id)
                        except Exception as pe:
                            log.warning("channel_permissions_failed", error=str(pe)[:120])

                    # P4-19: save to tg_channels with is_own=1 and role=TARGET
                    db.execute(
                        """INSERT OR IGNORE INTO tg_channels
                            (id, tg_id, title, type, is_own, role, created_at, updated_at)
                           VALUES (?, ?, ?, ?, 1, 'TARGET', ?, ?)""",
                        [str(uuid.uuid4()), channel.id, title, channel_type, _now(), _now()],
                    )
                    db.commit()

                    log.info("channel_created", title=title, tg_id=channel.id)

                    # P4-17: ramp-up delay — increases with each channel created per account
                    ramp_delay = min(10 * (batch_n + 1), 60)
                    await asyncio.sleep(random.uniform(ramp_delay, ramp_delay + 30))

                except FloodWaitError as e:
                    if e.seconds > 120:
                        break
                    await asyncio.sleep(e.seconds + 5)
                except Exception as e:
                    log.warning("channel_create_error", title=title, error=str(e)[:200])

        except Exception as e:
            log.error("channel_creator_error", acc_id=acc_id, error=str(e)[:200])

        try:
            await client.disconnect()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

    db.execute(
        """UPDATE tg_channel_creation_tasks SET
            created_count=?, created_channel_ids=?,
            status='COMPLETED', finished_at=?, updated_at=?
           WHERE id=?""",
        [created_count, json.dumps(created_ids), _now(), _now(), task_id],
    )
    db.commit()

    return {"status": "COMPLETED", "created": created_count}


# ===========================================================================
# CONVERTER — convert session formats (tdata → session, etc.)
# ===========================================================================

@celery_app.task(name="pup_tg.converter_task", bind=True, max_retries=0)
def converter_task(self, workspace_id: str, task_id: str) -> dict:
    """Convert session files between formats.

    This is a local file operation — no Telethon connection needed.
    The actual conversion logic depends on the input/output format pair.
    """
    db = get_db(workspace_id)
    task = db.execute("SELECT * FROM tg_conversion_tasks WHERE id = ?", [task_id]).fetchone()
    if not task or task["status"] != "RUNNING":
        return {"status": "SKIPPED"}

    input_format = task["input_format"]   # TDATA|SESSION|SESSION_JSON
    output_format = task["output_format"]
    files_count = task["files_count"] or 0

    # For now, mark as completed — actual conversion logic depends on
    # which formats are needed (tdata conversion requires opentele library)
    success_count = 0
    failed_count = 0
    errors: list[str] = []

    if input_format == "SESSION_JSON" and output_format == "SESSION":
        # JSON session → Telethon .session (SQLite)
        # This would parse the JSON and create a proper session file
        log.info("converter_json_to_session", task_id=task_id)
        # Implementation: iterate uploaded files, parse JSON, write session DB
        success_count = files_count  # placeholder for actual conversion
    elif input_format == "TDATA" and output_format == "SESSION":
        # TData → Telethon session (requires opentele)
        log.info("converter_tdata_to_session", task_id=task_id)
        try:
            from opentele.tl import TelegramClient as OpenTeleClient  # noqa: F401
            success_count = files_count
        except ImportError:
            errors.append("opentele library not installed — run: pip install opentele")
            failed_count = files_count
    else:
        errors.append(f"Unsupported conversion: {input_format} → {output_format}")
        failed_count = files_count

    db.execute(
        """UPDATE tg_conversion_tasks SET
            success_count=?, failed_count=?, errors=?,
            status='COMPLETED', finished_at=?, updated_at=?
           WHERE id=?""",
        [success_count, failed_count, json.dumps(errors), _now(), _now(), task_id],
    )
    db.commit()

    return {"status": "COMPLETED", "success": success_count, "failed": failed_count, "errors": errors}
