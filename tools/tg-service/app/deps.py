"""FastAPI dependency injection helpers."""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Query, status

from app.core.database import connect_db
from app.core.security import verify_admin_token

_WORKSPACE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,128}$")


def _workspace_id(
    workspace: str | None = Query(None),
    x_workspace_id: str | None = Header(None),
) -> str:
    """Resolve workspace identifier from query param or header."""
    ws = workspace or x_workspace_id or "default"
    if not _WORKSPACE_ID_RE.match(ws):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid workspace ID — must be alphanumeric, hyphens, underscores only",
        )
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


def get_workspace_db(workspace_id: WorkspaceId) -> Iterator[sqlite3.Connection]:
    """Yield a fresh per-request SQLite connection, closed when the request ends.

    A new connection per request gives each request an isolated transaction,
    so concurrent requests can no longer commit or roll back each other's
    in-flight writes on a shared connection. Closing on exit discards any
    uncommitted changes (a handler that forgot to ``commit()`` does not
    silently persist).
    """
    conn = connect_db(workspace_id)
    try:
        yield conn
    finally:
        conn.close()


WorkspaceDB = Annotated[sqlite3.Connection, Depends(get_workspace_db)]
