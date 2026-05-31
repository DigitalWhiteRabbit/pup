"""Dashboard aggregate statistics endpoint."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
async def dashboard_stats(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, Any]:
    """Aggregate stats across accounts and proxies for the workspace dashboard."""

    # --- Accounts ---
    all_acc_statuses = [
        "ACTIVE", "SPAM_BLOCKED", "FLOOD_WAIT", "BANNED",
        "DEAD", "IMPORTED", "WARMING", "PAUSED",
    ]
    acc_status_rows = db.execute(
        "SELECT status, COUNT(*) AS cnt FROM tg_accounts GROUP BY status"
    ).fetchall()

    accounts_by_status: dict[str, int] = {s: 0 for s in all_acc_statuses}
    accounts_total = 0
    for r in acc_status_rows:
        accounts_by_status[r["status"]] = r["cnt"]
        accounts_total += r["cnt"]

    acc_with_proxy_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_accounts WHERE proxy_id IS NOT NULL"
    ).fetchone()
    accounts_with_proxy = acc_with_proxy_row["cnt"] if acc_with_proxy_row else 0

    acc_premium_row = db.execute(
        "SELECT COUNT(*) AS cnt FROM tg_accounts WHERE is_premium = 1"
    ).fetchone()
    accounts_premium = acc_premium_row["cnt"] if acc_premium_row else 0

    avg_warmup_row = db.execute(
        "SELECT AVG(warmup_level) AS avg_wl FROM tg_accounts"
    ).fetchone()
    avg_warmup_level = round(avg_warmup_row["avg_wl"] or 0)

    # --- Proxies ---
    all_proxy_statuses = ["ACTIVE", "DEAD", "PAUSED", "EXPIRED"]
    all_proxy_types = ["RESIDENTIAL", "MOBILE", "DATACENTER"]

    proxy_status_rows = db.execute(
        "SELECT status, COUNT(*) AS cnt FROM tg_proxies GROUP BY status"
    ).fetchall()

    proxies_by_status: dict[str, int] = {s: 0 for s in all_proxy_statuses}
    proxies_total = 0
    for r in proxy_status_rows:
        proxies_by_status[r["status"]] = r["cnt"]
        proxies_total += r["cnt"]

    proxy_type_rows = db.execute(
        "SELECT type, COUNT(*) AS cnt FROM tg_proxies GROUP BY type"
    ).fetchall()
    proxies_by_type: dict[str, int] = {t: 0 for t in all_proxy_types}
    for r in proxy_type_rows:
        proxies_by_type[r["type"]] = r["cnt"]

    # --- Recent events (last 20 audit log entries) ---
    event_rows = db.execute(
        """SELECT id, event_type, severity, entity_type, entity_id,
                  message, metadata, ip_address, created_at
           FROM tg_audit_logs
           ORDER BY created_at DESC
           LIMIT 20"""
    ).fetchall()

    recent_events: list[dict[str, Any]] = []
    for r in event_rows:
        event = dict(r)
        if event.get("metadata"):
            try:
                event["metadata"] = json.loads(event["metadata"])
            except (json.JSONDecodeError, TypeError):
                event["metadata"] = None
        recent_events.append(event)

    # --- Top parsers (completed, by total_found) ---
    parsers: list[dict[str, Any]] = []
    try:
        parser_rows = db.execute(
            """SELECT name, total_found FROM tg_parsing_tasks
               WHERE status = 'COMPLETED' AND total_found > 0
               ORDER BY total_found DESC LIMIT 5"""
        ).fetchall()
        parsers = [{"name": r["name"], "total_found": r["total_found"]} for r in parser_rows]
    except Exception:
        pass

    # --- Active campaigns (DM) ---
    campaigns: list[dict[str, Any]] = []
    try:
        camp_rows = db.execute(
            """SELECT name, sent_count, total_recipients, replied_count
               FROM tg_dm_campaigns
               WHERE status IN ('RUNNING', 'COMPLETED')
               ORDER BY updated_at DESC LIMIT 3"""
        ).fetchall()
        campaigns = [dict(r) for r in camp_rows]
    except Exception:
        pass

    # --- AI spent this month ---
    ai_spent = 0.0
    try:
        stg = db.execute(
            "SELECT ai_spent_this_month_usd FROM tg_settings WHERE id = 'default'"
        ).fetchone()
        if stg:
            ai_spent = stg["ai_spent_this_month_usd"] or 0.0
    except Exception:
        pass

    # --- Pending approval (AI messages) ---
    pending_approval = 0
    try:
        pa_row = db.execute(
            "SELECT COUNT(*) AS cnt FROM tg_ai_messages WHERE status = 'PENDING'"
        ).fetchone()
        pending_approval = pa_row["cnt"] if pa_row else 0
    except Exception:
        pass

    return {
        "accounts_total": accounts_total,
        "accounts_by_status": accounts_by_status,
        "accounts_with_proxy": accounts_with_proxy,
        "accounts_without_proxy": accounts_total - accounts_with_proxy,
        "accounts_premium": accounts_premium,
        "avg_warmup_level": avg_warmup_level,
        "proxies": {
            "total": proxies_total,
            "active": proxies_by_status.get("ACTIVE", 0),
            "unchecked": 0,
        },
        "proxies_total": proxies_total,
        "proxies_by_status": proxies_by_status,
        "proxies_by_type": proxies_by_type,
        "parsers": parsers,
        "campaigns": campaigns,
        "ai_spent": ai_spent,
        "pending_approval": pending_approval,
        "recent_events": recent_events,
    }
