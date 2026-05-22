"""Unit tests for the per-workspace SQLite database manager."""

from __future__ import annotations

from pathlib import Path

from app.core.database import get_db, reset_cache

_SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / "schema.sql"


class TestGetDb:
    """get_db must create, schema-init, and cache workspace databases."""

    def test_get_db_creates_file(self, tmp_data_dir: Path) -> None:
        """Calling get_db for a new workspace creates the .db file on disk."""
        get_db("alpha", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)
        db_file = tmp_data_dir / "ws-alpha.db"
        assert db_file.exists()

    def test_get_db_applies_schema(self, tmp_data_dir: Path) -> None:
        """A freshly-created DB must contain all tables from schema.sql."""
        conn = get_db("beta", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        table_names = {row["name"] for row in rows}

        expected = {
            "tg_accounts",
            "tg_proxies",
            "tg_settings",
            "tg_audit_logs",
            "tg_kb_documents",
            "tg_kb_chunks",
            "settings",
        }
        assert expected.issubset(table_names), f"Missing tables: {expected - table_names}"

    def test_get_db_caches_connection(self, tmp_data_dir: Path) -> None:
        """Repeated calls with the same workspace_id must return the same object."""
        conn1 = get_db("gamma", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)
        conn2 = get_db("gamma", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)
        assert conn1 is conn2

    def test_different_workspaces_different_dbs(self, tmp_data_dir: Path) -> None:
        """Different workspace IDs must yield separate database files and connections."""
        conn_a = get_db("ws-one", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)
        conn_b = get_db("ws-two", data_dir=tmp_data_dir, schema_path=_SCHEMA_PATH)

        assert conn_a is not conn_b

        # Verify they are distinct files
        assert (tmp_data_dir / "ws-ws-one.db").exists()
        assert (tmp_data_dir / "ws-ws-two.db").exists()

        # Write to one, ensure the other is unaffected
        conn_a.execute(
            "INSERT INTO settings (key, value) VALUES ('test_key', 'from_ws_one')"
        )
        conn_a.commit()

        row_b = conn_b.execute(
            "SELECT value FROM settings WHERE key = 'test_key'"
        ).fetchone()
        assert row_b is None, "Data must not leak between workspace databases"
