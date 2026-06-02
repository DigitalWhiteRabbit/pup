"""Honest Celery dispatch helper.

Previously the start-endpoints did ``try: send_task() except: log.warning(...)``
— so when the broker was unreachable the task was still marked ACTIVE/RUNNING
while nothing ever executed. ``dispatch_task`` instead fails fast and raises
``503`` so the API surfaces the problem and the caller leaves the entity in its
prior state.
"""

from __future__ import annotations

from typing import Any, Sequence

import structlog
from fastapi import HTTPException, status

log = structlog.get_logger(__name__)

ENGINE_DOWN_DETAIL = (
    "Фоновый движок недоступен — задача не запущена. "
    "Запустите воркер: ./scripts/dev-up.sh"
)


def dispatch_task(
    name: str,
    *,
    args: Sequence[Any],
    queue: str = "pup_tg_default",
) -> str:
    """Send a Celery task, raising HTTP 503 if the broker is unreachable.

    Returns the dispatched task id. Fails fast (no long connection retry loop)
    so a down broker does not hang the request.
    """
    from app.tasks.celery_app import celery_app

    try:
        conn = celery_app.connection()
        try:
            conn.ensure_connection(max_retries=1, timeout=3)
            result = celery_app.send_task(
                name, args=list(args), queue=queue, connection=conn, retry=False
            )
        finally:
            conn.release()
        return result.id
    except Exception as exc:  # noqa: BLE001
        log.warning("celery_dispatch_failed", task=name, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=ENGINE_DOWN_DETAIL,
        ) from exc
