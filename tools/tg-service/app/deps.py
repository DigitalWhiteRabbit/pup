"""FastAPI dependency injection helpers."""

from __future__ import annotations

import sqlite3
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Query, status

from app.core.database import get_db
from app.core.security import verify_admin_token


def _workspace_id(
    workspace: str | None = Query(None),
    x_workspace_id: str | None = Header(None),
) -> str:
    """Resolve workspace identifier from query param or header."""
    ws = workspace or x_workspace_id or "default"
    return ws


def _require_admin(x_admin_token: str | None = Header(None)) -> str:
    """Verify the admin bearer token; raise 401 on failure."""
    if not x_admin_token or not verify_admin_token(x_admin_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing admin token",
        )
    return x_admin_token


WorkspaceId = Annotated[str, Depends(_workspace_id)]
AdminAuth = Annotated[str, Depends(_require_admin)]


def get_workspace_db(workspace_id: WorkspaceId) -> sqlite3.Connection:
    """Return the SQLite connection for the current workspace."""
    return get_db(workspace_id)


WorkspaceDB = Annotated[sqlite3.Connection, Depends(get_workspace_db)]
