"""Smoke-test endpoints for health and connectivity checks."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import AdminAuth, WorkspaceDB

router = APIRouter(tags=["smoke"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Basic liveness probe -- no auth required."""
    return {"status": "ok"}


@router.get("/smoke/db")
async def smoke_db(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict[str, object]:
    """Verify SQLite connectivity for the resolved workspace (admin only)."""
    row = db.execute("SELECT COUNT(*) AS n FROM tg_settings").fetchone()
    return {"status": "ok", "settings_rows": row["n"] if row else 0}
