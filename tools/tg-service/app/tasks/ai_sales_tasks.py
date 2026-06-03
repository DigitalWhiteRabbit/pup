"""Celery tasks for the AI Sales Agent (AI Prodazhnik).

Two tasks:
  1. ``pup_tg.ai_sales_monitor``  -- periodic scan of incoming DMs for
     active sales scripts.  Picks up new messages, creates dialogs,
     generates AI replies, and sends them via Telethon.
  2. ``pup_tg.ai_sales_reply``    -- on-demand reply for a single dialog.

RAG is keyword-based: user message words are matched against
``tg_kb_chunks`` for the script's ``rag_doc_ids``.  Top-3 matching
chunks are injected into the system prompt.

Stage progression follows the ``stages`` JSON array on the script: if the
user's message contains any ``advance_keywords`` for the current stage,
the dialog moves to ``next_stage``.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from app.ai.anthropic_client import generate_chat
from app.config import settings
from app.core.database import get_db
from app.core.security import decrypt_bytes
from app.services.dm_ownership import any_active_dm_agent
from app.tasks.celery_app import celery_app

log = structlog.get_logger(__name__)

# ── Terminal lead statuses (no AI replies for these) ─────────────────────────
_TERMINAL_STATUSES = {"CONVERTED", "LOST", "HANDED_OFF"}

# ── Default model mapping to full Anthropic model IDs ────────────────────────
_MODEL_MAP: dict[str, str] = {
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6": "claude-sonnet-4-6-20260514",
    "claude-opus-4-6": "claude-opus-4-6-20260514",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_model(short: str) -> str:
    """Turn a short model name into the full Anthropic model ID."""
    return _MODEL_MAP.get(short, short)


def _build_proxy_kwargs(db: Any, proxy_id: str) -> dict[str, Any]:
    # P5-02: delegate to the shared builder (was duplicated across ~10 modules).
    from app.services.tg_runner import build_proxy_kwargs
    return build_proxy_kwargs(db, proxy_id)



def _connect_account_info(db: Any, account_id: str) -> dict[str, Any] | None:
    """Load account row, decrypt session, build connection info dict.

    Same pattern as ``dm_campaign_tasks._connect_account``.
    """
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

    tmp_dir = Path(tempfile.mkdtemp(prefix="sales_"))
    tmp_session = tmp_dir / "sales.session"
    tmp_session.write_bytes(acc_info["session_bytes"])

    client = TelegramClient(
        str(tmp_session.with_suffix("")),
        acc_info["app_id"],
        acc_info["app_hash"],
        timeout=30,
        connection_retries=3,
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


# ── RAG: keyword-based chunk search ─────────────────────────────────────────

def _search_rag_chunks(
    db: Any,
    rag_doc_ids: list[str],
    user_message: str,
    top_k: int = 3,
) -> list[str]:
    """Return up to *top_k* chunk texts relevant to *user_message*.

    Uses simple keyword matching: tokenise the message, query chunks
    whose ``text`` contains any of the keywords, then rank by number
    of keyword hits.
    """
    if not rag_doc_ids:
        return []

    # Tokenise: lowercase words >= 3 chars, strip punctuation
    words = re.findall(r"[a-zA-Z\u0400-\u04FF]{3,}", user_message.lower())
    if not words:
        return []

    # Only unique words, limit to 20 to keep the query sane
    keywords = list(dict.fromkeys(words))[:20]

    # Fetch all chunks belonging to the requested docs
    placeholders = ",".join("?" for _ in rag_doc_ids)
    rows = db.execute(
        f"SELECT id, text FROM tg_kb_chunks WHERE document_id IN ({placeholders})",
        rag_doc_ids,
    ).fetchall()

    if not rows:
        return []

    # Score each chunk by keyword hits
    scored: list[tuple[int, str]] = []
    for row in rows:
        chunk_lower = row["text"].lower()
        hits = sum(1 for kw in keywords if kw in chunk_lower)
        if hits > 0:
            scored.append((hits, row["text"]))

    # Sort descending by hits, take top_k
    scored.sort(key=lambda x: x[0], reverse=True)
    return [text for _, text in scored[:top_k]]


def _build_rag_context(chunks: list[str]) -> str:
    """Format RAG chunks for injection into the system prompt."""
    if not chunks:
        return ""
    parts = "\n\n---\n\n".join(chunks)
    return (
        "\n\nHere is relevant knowledge base information:\n\n"
        f"---\n\n{parts}\n\n---"
    )


# ── Stage progression ────────────────────────────────────────────────────────

def _get_stages(script: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse the stages JSON from a script row."""
    raw = script.get("stages") or "[]"
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    return raw  # type: ignore[return-value]


def _evaluate_stage_advance(
    stages: list[dict[str, Any]],
    current_stage: str,
    user_message: str,
) -> str | None:
    """Return the next stage name if advance_keywords match, else None."""
    msg_lower = user_message.lower()
    for stage in stages:
        if stage.get("name") != current_stage:
            continue
        advance_kw = stage.get("advance_keywords", [])
        if not advance_kw:
            return None
        for kw in advance_kw:
            if kw.lower() in msg_lower:
                return stage.get("next_stage")
    return None


def _lead_status_for_stage(
    stages: list[dict[str, Any]],
    stage_name: str,
) -> str:
    """Derive a lead_status from the stage position in the funnel.

    Heuristic: first quarter = ENGAGING, second = QUALIFIED, third =
    PROPOSAL, last = PROPOSAL.  Overridden if the stage object has an
    explicit ``lead_status`` field.
    """
    if not stages:
        return "ENGAGING"

    for stage in stages:
        if stage.get("name") == stage_name and stage.get("lead_status"):
            return stage["lead_status"]

    # Position-based heuristic
    names = [s.get("name") for s in stages]
    try:
        idx = names.index(stage_name)
    except ValueError:
        return "ENGAGING"

    ratio = idx / max(len(names) - 1, 1)
    if ratio < 0.25:
        return "ENGAGING"
    elif ratio < 0.50:
        return "QUALIFIED"
    else:
        return "PROPOSAL"


# ── Cost tracking ────────────────────────────────────────────────────────────

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
    limit = stg["ai_monthly_limit_usd"] if stg["ai_monthly_limit_usd"] is not None else 500.0
    spent = stg["ai_spent_this_month_usd"] or 0.0
    return spent < limit


# ── System prompt builder ────────────────────────────────────────────────────

def _build_system_prompt(
    script: dict[str, Any],
    stages: list[dict[str, Any]],
    current_stage: str,
    rag_context: str,
) -> str:
    """Assemble the full system prompt for the AI sales agent."""
    base = script["system_prompt"] or ""

    # Stage context
    stage_obj = None
    for s in stages:
        if s.get("name") == current_stage:
            stage_obj = s
            break

    stage_section = ""
    if stage_obj:
        stage_section = (
            f"\n\nCurrent sales stage: {current_stage}"
            f"\nStage goal: {stage_obj.get('goal', 'No specific goal defined')}"
        )
        if stage_obj.get("next_stage"):
            stage_section += f"\nNext stage: {stage_obj['next_stage']}"

    # Build all-stage overview
    all_stages = ""
    if stages:
        stage_names = [s.get("name", "?") for s in stages]
        all_stages = f"\n\nSales funnel stages: {' -> '.join(stage_names)}"

    instructions = (
        "\n\nIMPORTANT INSTRUCTIONS:"
        "\n- You are a sales assistant communicating via Telegram DM."
        "\n- Keep messages concise and natural, like a real person in a messenger."
        "\n- Do NOT use markdown formatting, headers, or bullet points."
        "\n- Do NOT reveal that you are an AI."
        "\n- Stay focused on the current stage goal."
        "\n- Be conversational, friendly, and professional."
        "\n- Write in the same language the user writes to you."
    )

    return base + all_stages + stage_section + rag_context + instructions


# ── Core reply generation ────────────────────────────────────────────────────

def _generate_reply(
    db: Any,
    script: dict[str, Any],
    dialog: dict[str, Any],
    user_message: str,
) -> dict[str, Any]:
    """Generate an AI reply for the given dialog and user message.

    Returns a dict with keys: text, model, tokens_in, tokens_out, cost_usd,
    new_stage, new_lead_status.
    """
    stages = _get_stages(script)
    current_stage = dialog["current_stage"] or "intro"

    # RAG
    rag_doc_ids: list[str] = []
    if script["rag_enabled"]:
        raw_ids = script.get("rag_doc_ids") or "[]"
        if isinstance(raw_ids, str):
            try:
                rag_doc_ids = json.loads(raw_ids)
            except (json.JSONDecodeError, TypeError):
                rag_doc_ids = []
        else:
            rag_doc_ids = raw_ids

    rag_chunks = _search_rag_chunks(db, rag_doc_ids, user_message) if rag_doc_ids else []
    rag_context = _build_rag_context(rag_chunks)

    # System prompt
    system_prompt = _build_system_prompt(script, stages, current_stage, rag_context)

    # Build conversation history from stored messages
    msg_rows = db.execute(
        "SELECT direction, text FROM tg_sales_messages WHERE dialog_id = ? ORDER BY created_at ASC",
        [dialog["id"]],
    ).fetchall()

    messages: list[dict[str, str]] = []
    for row in msg_rows:
        role = "assistant" if row["direction"] == "OUTBOUND" else "user"
        messages.append({"role": role, "content": row["text"]})

    # Append the current inbound message (it may already be saved, but we
    # add it here to ensure the latest turn is included)
    if not messages or messages[-1]["content"] != user_message:
        messages.append({"role": "user", "content": user_message})

    # Resolve model
    model = _resolve_model(script["ai_model"] or "claude-sonnet-4-6")

    # Call Claude
    result = generate_chat(
        system_prompt=system_prompt,
        messages=messages,
        model=model,
        max_tokens=512,
        temperature=0.7,
    )

    # Stage advancement
    new_stage = _evaluate_stage_advance(stages, current_stage, user_message)
    if new_stage is None:
        new_stage = current_stage
    new_lead_status = _lead_status_for_stage(stages, new_stage)

    return {
        "text": result["text"],
        "model": result["model"],
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
        "cost_usd": result["cost_usd"],
        "new_stage": new_stage,
        "new_lead_status": new_lead_status,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Task 1: pup_tg.ai_sales_monitor (periodic)
# ═══════════════════════════════════════════════════════════════════════════

# Interval between monitor cycles when at least one script is still ACTIVE.
_MONITOR_RESCHEDULE_SECONDS = 90


@celery_app.task(name="pup_tg.ai_sales_monitor", bind=True, max_retries=0)
def ai_sales_monitor(self, workspace_id: str) -> dict:
    """Scan incoming DMs for active sales scripts, generate and send replies.

    Self-reschedules while at least one sales script in this workspace is
    still ``ACTIVE`` so incoming DMs keep being processed. Stops naturally
    once no script is active (e.g. all stopped/paused).
    """
    # Single-ownership (ENGINE-CONSOLIDATION): the AI Agent is the sole owner of
    # incoming DMs. While any active persona owns DMs, AI Sales yields entirely
    # — it neither processes nor reschedules, so its independent poller is off.
    db0 = get_db(workspace_id)
    if any_active_dm_agent(db0):
        log.info("ai_sales_monitor_yielded_to_agent", workspace_id=workspace_id)
        return {"status": "SKIPPED", "reason": "AI Agent owns incoming DMs (consolidated)"}

    result = asyncio.run(_ai_sales_monitor_async(workspace_id))

    # Self-reschedule only while there is work to do for this workspace.
    try:
        db = get_db(workspace_id)
        active = db.execute(
            "SELECT COUNT(*) AS n FROM tg_sales_scripts WHERE status = 'ACTIVE'"
        ).fetchone()
        if active and active["n"] > 0:
            self.apply_async(
                args=[workspace_id],
                countdown=_MONITOR_RESCHEDULE_SECONDS,
                queue="pup_tg_default",
            )
            log.info(
                "ai_sales_monitor_rescheduled",
                workspace_id=workspace_id,
                countdown=_MONITOR_RESCHEDULE_SECONDS,
                active_scripts=active["n"],
            )
        else:
            log.info("ai_sales_monitor_stopped", workspace_id=workspace_id)
    except Exception:
        log.warning(
            "ai_sales_monitor_reschedule_failed", workspace_id=workspace_id, exc_info=True
        )

    return result


async def _ai_sales_monitor_async(workspace_id: str) -> dict:
    from telethon.errors import (
        AuthKeyUnregisteredError,
        FloodWaitError,
        PeerFloodError,
        UserDeactivatedBanError,
        UserPrivacyRestrictedError,
    )

    db = get_db(workspace_id)
    now = _now()

    # Budget check
    if not _check_ai_budget(db):
        log.warning("ai_sales_budget_exceeded", workspace_id=workspace_id)
        return {"status": "SKIPPED", "reason": "AI monthly budget exceeded"}

    # Load ACTIVE scripts
    scripts = db.execute(
        "SELECT * FROM tg_sales_scripts WHERE status = 'ACTIVE'"
    ).fetchall()

    if not scripts:
        return {"status": "SKIPPED", "reason": "No active sales scripts"}

    # Load ACTIVE accounts
    accounts = db.execute(
        "SELECT id FROM tg_accounts WHERE status = 'ACTIVE'"
    ).fetchall()
    if not accounts:
        return {"status": "SKIPPED", "reason": "No active accounts"}

    total_processed = 0
    total_replied = 0
    total_errors = 0

    for acc_row in accounts:
        acc_id = acc_row["id"]
        acc_info = _connect_account_info(db, acc_id)
        if not acc_info:
            log.warning("ai_sales_account_skip", account_id=acc_id)
            continue

        # NO_PROXY guard: never connect a proxy-less account over the real IP.
        if "proxy" not in acc_info["proxy_kwargs"]:
            log.warning("no_proxy_skip", account_id=acc_id, workspace_id=workspace_id)
            total_errors += 1
            continue

        client = None
        tmp_dir = None
        try:
            client, tmp_dir = await _make_client(acc_info)
        except AuthKeyUnregisteredError:
            db.execute(
                "UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?",
                [now, acc_id],
            )
            db.commit()
            log.error("ai_sales_account_dead", account_id=acc_id)
            continue
        except UserDeactivatedBanError:
            db.execute(
                "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
                [now, now, acc_id],
            )
            db.commit()
            log.error("ai_sales_account_banned", account_id=acc_id)
            continue
        except Exception as e:
            log.error("ai_sales_connect_error", account_id=acc_id, error=str(e)[:200])
            continue

        log.info("ai_sales_account_connected", account_id=acc_id, phone=acc_info["phone"])

        try:
            # Fetch recent dialogs (DMs)
            dialogs = await client.get_dialogs(limit=30)

            for tg_dialog in dialogs:
                # Only process user DMs (not channels/groups)
                if not tg_dialog.is_user:
                    continue

                # Skip if no unread messages
                if tg_dialog.unread_count == 0:
                    continue

                user_entity = tg_dialog.entity
                contact_user_id = user_entity.id
                contact_username = getattr(user_entity, "username", None) or ""
                contact_first = getattr(user_entity, "first_name", None) or ""
                contact_last = getattr(user_entity, "last_name", None) or ""
                contact_name = f"{contact_first} {contact_last}".strip()

                # Read unread messages from this user
                unread_msgs = await client.get_messages(
                    user_entity, limit=tg_dialog.unread_count
                )
                # Reverse to chronological order (oldest first)
                unread_msgs = list(reversed(unread_msgs))

                # Filter to only text messages from the contact (not our own)
                inbound_texts = []
                for msg in unread_msgs:
                    if msg.out or not msg.text:
                        continue
                    inbound_texts.append(msg.text)

                if not inbound_texts:
                    continue

                # Process against each active script
                for script_row in scripts:
                    script = dict(script_row)

                    # Check if dialog exists for this contact + script
                    existing_dialog = db.execute(
                        "SELECT * FROM tg_sales_dialogs WHERE contact_user_id = ? AND script_id = ?",
                        [contact_user_id, script["id"]],
                    ).fetchone()

                    if existing_dialog:
                        dialog = dict(existing_dialog)
                        # Skip terminal statuses
                        if dialog["lead_status"] in _TERMINAL_STATUSES:
                            continue
                    else:
                        # Create new dialog
                        stages = _get_stages(script)
                        first_stage = stages[0]["name"] if stages else "intro"

                        dialog_id = str(uuid.uuid4())
                        db.execute(
                            """INSERT INTO tg_sales_dialogs
                                (id, account_id, script_id, contact_user_id,
                                 contact_username, contact_name, current_stage,
                                 lead_status, messages_in, messages_out,
                                 created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)""",
                            [
                                dialog_id, acc_id, script["id"],
                                contact_user_id, contact_username, contact_name,
                                first_stage, "NEW", now, now,
                            ],
                        )
                        db.commit()

                        # Update script total_dialogs
                        db.execute(
                            "UPDATE tg_sales_scripts SET total_dialogs = total_dialogs + 1, updated_at = ? WHERE id = ?",
                            [now, script["id"]],
                        )
                        db.commit()

                        dialog = db.execute(
                            "SELECT * FROM tg_sales_dialogs WHERE id = ?", [dialog_id]
                        ).fetchone()
                        dialog = dict(dialog)
                        log.info(
                            "ai_sales_dialog_created",
                            dialog_id=dialog_id,
                            contact=contact_username or contact_user_id,
                            script=script["name"],
                        )

                    # Save all inbound messages
                    combined_inbound = ""
                    for text in inbound_texts:
                        msg_id = str(uuid.uuid4())
                        db.execute(
                            """INSERT INTO tg_sales_messages
                                (id, dialog_id, direction, text, stage, created_at)
                               VALUES (?, ?, 'INBOUND', ?, ?, ?)""",
                            [msg_id, dialog["id"], text, dialog["current_stage"], now],
                        )
                        combined_inbound += text + "\n"
                    combined_inbound = combined_inbound.strip()

                    # Update messages_in count
                    db.execute(
                        "UPDATE tg_sales_dialogs SET messages_in = messages_in + ?, last_message_at = ?, updated_at = ? WHERE id = ?",
                        [len(inbound_texts), now, now, dialog["id"]],
                    )
                    db.commit()
                    total_processed += len(inbound_texts)

                    # Budget re-check before each AI call
                    if not _check_ai_budget(db):
                        log.warning("ai_sales_budget_mid_run", dialog_id=dialog["id"])
                        continue

                    # Generate AI reply
                    try:
                        reply = _generate_reply(db, script, dialog, combined_inbound)
                    except Exception as e:
                        log.error(
                            "ai_sales_generate_error",
                            dialog_id=dialog["id"],
                            error=str(e)[:200],
                        )
                        total_errors += 1
                        continue

                    # Save outbound message
                    out_msg_id = str(uuid.uuid4())
                    db.execute(
                        """INSERT INTO tg_sales_messages
                            (id, dialog_id, direction, text, stage, ai_model,
                             tokens_in, tokens_out, cost_usd, created_at)
                           VALUES (?, ?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?)""",
                        [
                            out_msg_id, dialog["id"], reply["text"],
                            reply["new_stage"], reply["model"],
                            reply["tokens_in"], reply["tokens_out"],
                            reply["cost_usd"], now,
                        ],
                    )
                    db.commit()

                    # Track AI cost
                    _track_ai_cost(db, reply["cost_usd"])

                    # Send reply via Telethon
                    try:
                        await client.send_message(user_entity, reply["text"])
                        total_replied += 1

                        # Update dialog state
                        db.execute(
                            """UPDATE tg_sales_dialogs SET
                                messages_out = messages_out + 1,
                                current_stage = ?,
                                lead_status = ?,
                                last_message_at = ?,
                                updated_at = ?
                               WHERE id = ?""",
                            [
                                reply["new_stage"], reply["new_lead_status"],
                                now, now, dialog["id"],
                            ],
                        )
                        db.commit()

                        log.info(
                            "ai_sales_reply_sent",
                            dialog_id=dialog["id"],
                            contact=contact_username or contact_user_id,
                            stage=reply["new_stage"],
                            cost=reply["cost_usd"],
                        )

                    except FloodWaitError as e:
                        log.warning(
                            "ai_sales_flood_wait",
                            account_id=acc_id,
                            wait=e.seconds,
                        )
                        if e.seconds > 300:
                            db.execute(
                                "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                                [now, acc_id],
                            )
                            db.commit()
                            break  # stop processing with this account
                        else:
                            await asyncio.sleep(e.seconds + 5)

                    except PeerFloodError:
                        log.error("ai_sales_peer_flood", account_id=acc_id)
                        db.execute(
                            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                            [now, acc_id],
                        )
                        db.commit()
                        total_errors += 1
                        break

                    except UserPrivacyRestrictedError:
                        log.info(
                            "ai_sales_privacy_restricted",
                            contact=contact_username or contact_user_id,
                        )
                        total_errors += 1
                        continue

                    except Exception as e:
                        log.error(
                            "ai_sales_send_error",
                            dialog_id=dialog["id"],
                            error=str(e)[:200],
                        )
                        total_errors += 1
                        continue

                # Mark dialog as read
                try:
                    await client.send_read_acknowledge(user_entity)
                except Exception:
                    pass

        except Exception as e:
            log.error("ai_sales_scan_error", account_id=acc_id, error=str(e)[:200])
            total_errors += 1
        finally:
            if client and tmp_dir:
                await _disconnect_client(client, tmp_dir)

    # Audit log
    db.execute(
        """INSERT INTO tg_audit_logs (event_type, severity, entity_type, entity_id, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            "ai_sales.monitor_complete", "INFO", "ai_sales", workspace_id,
            f"AI Sales monitor: {total_processed} messages processed, {total_replied} replies sent, {total_errors} errors",
            json.dumps({
                "processed": total_processed,
                "replied": total_replied,
                "errors": total_errors,
            }),
            _now(),
        ],
    )
    db.commit()

    result = {
        "status": "OK",
        "processed": total_processed,
        "replied": total_replied,
        "errors": total_errors,
    }
    log.info("ai_sales_monitor_complete", workspace_id=workspace_id, **result)
    return result


# ═══════════════════════════════════════════════════════════════════════════
# Task 2: pup_tg.ai_sales_reply (on-demand, single dialog)
# ═══════════════════════════════════════════════════════════════════════════

@celery_app.task(name="pup_tg.ai_sales_reply", bind=True, max_retries=2)
def ai_sales_reply(self, workspace_id: str, dialog_id: str) -> dict:
    """Generate and send an AI reply for a specific sales dialog."""
    return asyncio.run(_ai_sales_reply_async(workspace_id, dialog_id))


async def _ai_sales_reply_async(workspace_id: str, dialog_id: str) -> dict:
    from telethon.errors import (
        AuthKeyUnregisteredError,
        FloodWaitError,
        PeerFloodError,
        UserDeactivatedBanError,
        UserPrivacyRestrictedError,
    )

    db = get_db(workspace_id)
    now = _now()

    # Budget check
    if not _check_ai_budget(db):
        return {"status": "FAILED", "error": "AI monthly budget exceeded"}

    # Load dialog
    dialog_row = db.execute(
        "SELECT * FROM tg_sales_dialogs WHERE id = ?", [dialog_id]
    ).fetchone()
    if not dialog_row:
        return {"status": "FAILED", "error": "Dialog not found"}
    dialog = dict(dialog_row)

    if dialog["lead_status"] in _TERMINAL_STATUSES:
        return {"status": "SKIPPED", "error": f"Dialog in terminal status: {dialog['lead_status']}"}

    # Load script
    script_row = db.execute(
        "SELECT * FROM tg_sales_scripts WHERE id = ?", [dialog.get("script_id")]
    ).fetchone()
    if not script_row:
        return {"status": "FAILED", "error": "Script not found"}
    script = dict(script_row)

    # Load latest inbound message as context
    last_inbound = db.execute(
        "SELECT text FROM tg_sales_messages WHERE dialog_id = ? AND direction = 'INBOUND' ORDER BY created_at DESC LIMIT 1",
        [dialog_id],
    ).fetchone()
    if not last_inbound:
        return {"status": "SKIPPED", "error": "No inbound messages to reply to"}
    user_message = last_inbound["text"]

    # Generate reply
    try:
        reply = _generate_reply(db, script, dialog, user_message)
    except Exception as e:
        log.error("ai_sales_reply_generate_error", dialog_id=dialog_id, error=str(e)[:200])
        return {"status": "FAILED", "error": f"AI generation failed: {str(e)[:200]}"}

    # Save outbound message
    out_msg_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO tg_sales_messages
            (id, dialog_id, direction, text, stage, ai_model,
             tokens_in, tokens_out, cost_usd, created_at)
           VALUES (?, ?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?)""",
        [
            out_msg_id, dialog_id, reply["text"],
            reply["new_stage"], reply["model"],
            reply["tokens_in"], reply["tokens_out"],
            reply["cost_usd"], now,
        ],
    )
    db.commit()

    # Track cost
    _track_ai_cost(db, reply["cost_usd"])

    # Connect to Telegram and send
    acc_id = dialog.get("account_id")
    if not acc_id:
        # No account linked -- pick first active
        acc_row = db.execute("SELECT id FROM tg_accounts WHERE status = 'ACTIVE' LIMIT 1").fetchone()
        if not acc_row:
            return {
                "status": "PARTIAL",
                "reply_text": reply["text"],
                "error": "No active accounts to send message",
            }
        acc_id = acc_row["id"]

    acc_info = _connect_account_info(db, acc_id)
    if not acc_info:
        return {
            "status": "PARTIAL",
            "reply_text": reply["text"],
            "error": f"Account {acc_id} not available",
        }

    # NO_PROXY guard: never connect a proxy-less account over the real IP.
    if "proxy" not in acc_info["proxy_kwargs"]:
        log.warning("no_proxy_skip", account_id=acc_id, dialog_id=dialog_id)
        return {
            "status": "PARTIAL",
            "reply_text": reply["text"],
            "error": "NO_PROXY: нет активного прокси",
        }

    client = None
    tmp_dir = None
    try:
        client, tmp_dir = await _make_client(acc_info)
    except AuthKeyUnregisteredError:
        db.execute("UPDATE tg_accounts SET status='DEAD', updated_at=? WHERE id=?", [now, acc_id])
        db.commit()
        return {"status": "PARTIAL", "reply_text": reply["text"], "error": "Account auth key invalid"}
    except UserDeactivatedBanError:
        db.execute(
            "UPDATE tg_accounts SET status='BANNED', banned_at=?, updated_at=? WHERE id=?",
            [now, now, acc_id],
        )
        db.commit()
        return {"status": "PARTIAL", "reply_text": reply["text"], "error": "Account banned"}
    except Exception as e:
        return {"status": "PARTIAL", "reply_text": reply["text"], "error": f"Connect failed: {str(e)[:200]}"}

    try:
        # Resolve contact entity
        contact_user_id = dialog["contact_user_id"]
        contact_username = dialog.get("contact_username")

        entity = None
        if contact_username:
            try:
                entity = await client.get_entity(f"@{contact_username}")
            except Exception:
                pass
        if entity is None:
            entity = await client.get_entity(contact_user_id)

        # Send
        await client.send_message(entity, reply["text"])

        # Update dialog
        db.execute(
            """UPDATE tg_sales_dialogs SET
                messages_out = messages_out + 1,
                current_stage = ?,
                lead_status = ?,
                last_message_at = ?,
                updated_at = ?
               WHERE id = ?""",
            [reply["new_stage"], reply["new_lead_status"], now, now, dialog_id],
        )
        db.commit()

        log.info(
            "ai_sales_reply_sent",
            dialog_id=dialog_id,
            contact=contact_username or contact_user_id,
            stage=reply["new_stage"],
            cost=reply["cost_usd"],
        )

        return {
            "status": "SENT",
            "reply_text": reply["text"],
            "stage": reply["new_stage"],
            "lead_status": reply["new_lead_status"],
            "tokens_in": reply["tokens_in"],
            "tokens_out": reply["tokens_out"],
            "cost_usd": reply["cost_usd"],
        }

    except FloodWaitError as e:
        log.warning("ai_sales_reply_flood", account_id=acc_id, wait=e.seconds)
        if e.seconds > 300:
            db.execute(
                "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
                [now, acc_id],
            )
            db.commit()
        return {
            "status": "PARTIAL",
            "reply_text": reply["text"],
            "error": f"FloodWait {e.seconds}s",
        }

    except PeerFloodError:
        db.execute(
            "UPDATE tg_accounts SET status='FLOOD_WAIT', updated_at=? WHERE id=?",
            [now, acc_id],
        )
        db.commit()
        return {"status": "PARTIAL", "reply_text": reply["text"], "error": "PeerFlood"}

    except UserPrivacyRestrictedError:
        return {
            "status": "FAILED",
            "reply_text": reply["text"],
            "error": "User privacy restricted",
        }

    except Exception as e:
        log.error("ai_sales_reply_send_error", dialog_id=dialog_id, error=str(e)[:200])
        return {
            "status": "PARTIAL",
            "reply_text": reply["text"],
            "error": str(e)[:200],
        }

    finally:
        if client and tmp_dir:
            await _disconnect_client(client, tmp_dir)
