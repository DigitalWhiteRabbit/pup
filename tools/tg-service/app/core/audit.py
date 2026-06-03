"""Unified audit logging for hot-path operations (check / spamblock / apply / send).

A single sink so every hot-path action lands in ``tg_audit_logs`` with a
consistent shape. ``record_audit()`` is best-effort and **never raises** — audit
must never break the operation it observes. This is especially important on the
send-path: the audit hook is pure observability and must not change send
behaviour, ordering, or anti-ban timing.
"""

from __future__ import annotations

import json
from typing import Any

import structlog

log = structlog.get_logger(__name__)


def record_audit(
    db: Any,
    event_type: str,
    message: str,
    *,
    severity: str = "INFO",
    entity_type: str | None = None,
    entity_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Insert one row into ``tg_audit_logs``. Never raises (best-effort).

    Used both directly (e.g. on the inline worker send-path) and by the
    :func:`audit_endpoint` decorator. On any failure it logs a warning and
    rolls back, so a broken audit write can never abort the hot path.
    """
    try:
        db.execute(
            "INSERT INTO tg_audit_logs "
            "(event_type, severity, entity_type, entity_id, message, metadata, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
            [
                event_type,
                severity,
                entity_type,
                entity_id,
                message,
                json.dumps(metadata, ensure_ascii=False) if metadata is not None else None,
            ],
        )
        db.commit()
    except Exception:  # noqa: BLE001 — audit must never break the hot path
        log.warning("audit_write_failed", event_type=event_type, exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


# NOTE: a literal cross-module *decorator* on the FastAPI endpoints was avoided
# on purpose. Those handlers use ``from __future__ import annotations`` (string
# return annotations like ``-> SpamblockResult``), which FastAPI resolves against
# the handler's ``__globals__``. A wrapper defined here would carry this module's
# globals and break that resolution. Instead, hot-path sites call ``record_audit``
# directly — one unified sink, no signature/DI risk.
