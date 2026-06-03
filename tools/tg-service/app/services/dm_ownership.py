"""Single-ownership of incoming DMs (engine consolidation).

The AI Agent (persona engine) is the single owner of incoming DMs for any
account it covers. AI Sales and the auto-replier must NOT poll / answer the
same account's DMs in parallel — they yield to the Agent.

Ownership rule: an account's incoming DMs are owned by the Agent iff there is
at least one ``ACTIVE`` persona with ``dm_enabled = 1`` whose ``account_ids``
JSON list contains that account id. (Empty ``account_ids`` means the persona
is idle — it covers no accounts; see ai_agent_tasks.py:1489.)

See ENGINE-CONSOLIDATION.md for the full migration map.
"""

from __future__ import annotations

import json

import structlog

log = structlog.get_logger(__name__)


def agent_owns_account_dms(db, account_id: str) -> bool:
    """True if an ACTIVE ``dm_enabled`` persona covers this account's DMs."""
    try:
        rows = db.execute(
            "SELECT account_ids FROM tg_ai_personas "
            "WHERE status = 'ACTIVE' AND dm_enabled = 1"
        ).fetchall()
    except Exception:  # noqa: BLE001 — table may be missing on a bare DB
        log.warning("dm_ownership_query_failed", exc_info=True)
        return False
    for r in rows:
        try:
            acc_ids = json.loads(r["account_ids"] or "[]")
        except (ValueError, TypeError):
            acc_ids = []
        if account_id in acc_ids:
            return True
    return False


def any_active_dm_agent(db) -> bool:
    """True if any ACTIVE persona owns incoming DMs (``dm_enabled = 1``).

    Used to gate AI-Sales / auto-replier runtime entry points so they cannot
    start an independent incoming-DM poller while the Agent is the owner.
    """
    try:
        row = db.execute(
            "SELECT COUNT(*) AS n FROM tg_ai_personas "
            "WHERE status = 'ACTIVE' AND dm_enabled = 1"
        ).fetchone()
        return bool(row and row["n"] > 0)
    except Exception:  # noqa: BLE001
        log.warning("dm_ownership_count_failed", exc_info=True)
        return False
