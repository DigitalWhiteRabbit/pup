"""Pytest root configuration and shared fixtures for TG Service."""

from __future__ import annotations

import base64
import os
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

# ── Environment overrides (MUST happen before any app import) ────────────────
_TEST_SECRET = base64.b64encode(os.urandom(32)).decode()

os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("ADMIN_TOKEN", "test-token")
os.environ.setdefault("PUP_SECRET", _TEST_SECRET)

# Now safe to import app modules
from app.core.database import reset_cache  # noqa: E402

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture()
def tmp_data_dir(tmp_path: Path) -> Path:
    """Provide a temporary data directory for workspace DBs."""
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture()
def test_db(tmp_data_dir: Path) -> Iterator[sqlite3.Connection]:
    """Create a temp SQLite DB with the full schema applied.

    Yields the connection and cleans up afterwards.
    """
    db_path = tmp_data_dir / "test.db"
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")

    schema_sql = _SCHEMA_PATH.read_text(encoding="utf-8")
    conn.executescript(schema_sql)

    yield conn

    conn.close()


@pytest.fixture(autouse=True)
def _reset_db_cache() -> Iterator[None]:
    """Clear the workspace DB connection cache between tests."""
    reset_cache()
    yield
    reset_cache()
