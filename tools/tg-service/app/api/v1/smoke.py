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


@router.post("/smoke/ai-test")
async def ai_test(
    _token: AdminAuth,
    db: WorkspaceDB,
) -> dict:
    """Test Claude API connectivity."""
    try:
        from app.ai.anthropic_client import generate_message

        result = generate_message(
            system_prompt="You are a helpful assistant. Reply in one sentence.",
            user_message="Say hello in Russian.",
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
        )
        return {
            "success": True,
            "response": result["text"],
            "tokens_in": result["tokens_in"],
            "tokens_out": result["tokens_out"],
            "cost_usd": result["cost_usd"],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
