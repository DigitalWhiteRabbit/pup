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

    return {
        "accounts_total": accounts_total,
        "accounts_by_status": accounts_by_status,
        "accounts_with_proxy": accounts_with_proxy,
        "accounts_without_proxy": accounts_total - accounts_with_proxy,
        "accounts_premium": accounts_premium,
        "avg_warmup_level": avg_warmup_level,
        "proxies_total": proxies_total,
        "proxies_by_status": proxies_by_status,
        "proxies_by_type": proxies_by_type,
        "recent_events": recent_events,
    }
