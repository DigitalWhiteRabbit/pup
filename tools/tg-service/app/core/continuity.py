"""Unified worker continuity — heartbeat + reaper.

Generalises the ai_agent reaper pattern so long-running task loops survive a
worker restart. A worker calls :func:`touch_heartbeat` at the start of each run
(and inside its main loop for long runs); the beat reaper
(``pup_tg.worker_continuity``) revives tasks that are in a *running* state but
whose heartbeat is **stale** — i.e. their in-flight Celery task died on a worker
restart and nothing re-dispatched it.

Safety: a live loop keeps its heartbeat fresh, so it is **never** re-dispatched
as long as the heartbeat interval stays well below ``stale_seconds``. On
re-dispatch the reaper immediately bumps ``last_tick_at`` so the next sweep
won't double-fire before the revived task writes its own heartbeat.

Not covered here:
- ai_agent — has its own ``ai_agent_reaper`` (loop_token based).
- stories-boost AUTO_MONITOR — re-ticked by ``campaign_scheduler`` (P5-04).
- dm/chat-broadcast/invite — SCHEDULED start handled by ``campaign_scheduler``.

The table names below come from this fixed internal registry (never user
input), so the f-string interpolation is safe.
"""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(__name__)

# (table, id_col, status_col, running_values, task_name, stale_seconds)
#
# stale_seconds must exceed the worker's heartbeat interval AND a typical single
# run, or a slow-but-alive run could be falsely revived. auto_replier heartbeats
# every ~90s cycle → 600s is safe. commenting heartbeats per-account and is the
# continuous-monitor case → 1800s drives re-monitoring while staying > a run.
# boost/cloner complete normally (terminal status); their entry is pure
# orphan-recovery, so the threshold is generous.
CONTINUITY_SPECS: list[tuple[str, str, str, tuple[str, ...], str, int]] = [
    ("tg_commenting_tasks", "id", "status", ("ACTIVE",), "pup_tg.commenting_task", 1800),
    ("tg_auto_replier_scenarios", "id", "status", ("ACTIVE",), "pup_tg.auto_replier", 600),
    ("tg_boost_tasks", "id", "status", ("RUNNING",), "pup_tg.boost_task", 7200),
    ("tg_clone_tasks", "id", "status", ("RUNNING",), "pup_tg.cloner_task", 7200),
]

# Tables that carry a last_tick_at heartbeat column (for the migration).
HEARTBEAT_TABLES = [spec[0] for spec in CONTINUITY_SPECS]


def touch_heartbeat(db: Any, table: str, task_id: str) -> None:
    """Mark a task alive (``last_tick_at = now``). Never raises."""
    try:
        db.execute(
            f"UPDATE {table} SET last_tick_at = datetime('now') WHERE id = ?",
            [task_id],
        )
        db.commit()
    except Exception:  # noqa: BLE001 — heartbeat must never break the worker
        log.warning("heartbeat_failed", table=table, exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def revive_stale_loops(db: Any, workspace_id: str, celery_app: Any) -> list[dict]:
    """Re-dispatch running-state tasks whose heartbeat is stale. Returns revived."""
    revived: list[dict] = []
    for table, id_col, status_col, running_vals, task_name, stale in CONTINUITY_SPECS:
        status_ph = ",".join("?" * len(running_vals))
        try:
            rows = db.execute(
                f"SELECT {id_col} AS id FROM {table} "
                f"WHERE {status_col} IN ({status_ph}) "
                f"AND (last_tick_at IS NULL OR last_tick_at < datetime('now', ?))",
                [*running_vals, f"-{stale} seconds"],
            ).fetchall()
        except Exception:  # noqa: BLE001 — missing table/column on a bare DB
            continue
        for r in rows:
            tid = r["id"]
            try:
                celery_app.send_task(
                    task_name, args=[workspace_id, tid], queue="pup_tg_default"
                )
                # Bump heartbeat now so the next sweep won't re-dispatch before
                # the revived task writes its own heartbeat.
                db.execute(
                    f"UPDATE {table} SET last_tick_at = datetime('now') WHERE {id_col} = ?",
                    [tid],
                )
                db.commit()
                revived.append({"table": table, "id": tid, "task": task_name})
                log.info("continuity_revived", table=table, id=tid, task=task_name)
            except Exception:  # noqa: BLE001
                log.warning("continuity_revive_failed", table=table, id=tid, exc_info=True)
    return revived
