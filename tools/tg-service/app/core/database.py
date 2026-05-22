"""Per-workspace SQLite database manager.

Each workspace gets its own SQLite file under ``data/ws-{workspace_id}.db``.
On first access the schema from ``schema.sql`` is applied automatically.
Connections are cached for the lifetime of the process.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import structlog

from app.config import settings

log = structlog.get_logger(__name__)

_SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / "schema.sql"

_lock = threading.Lock()
_connections: dict[str, sqlite3.Connection] = {}


def _data_dir() -> Path:
    """Return (and lazily create) the data directory."""
    d = settings.data_dir
    d.mkdir(parents=True, exist_ok=True)
    return d


def _apply_schema(conn: sqlite3.Connection, schema_path: Path) -> None:
    """Execute schema.sql against a fresh database."""
    schema_sql = schema_path.read_text(encoding="utf-8")
    conn.executescript(schema_sql)


def _apply_migrations(conn: sqlite3.Connection) -> None:
    """Apply incremental migrations to an existing database.

    Each migration checks whether it is needed before running, so this
    is safe to call on every connection open.
    """
    # Migration: add proxy_seller_api_key column to tg_settings
    try:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(tg_settings)").fetchall()
        }
        if "proxy_seller_api_key" not in cols:
            conn.execute(
                "ALTER TABLE tg_settings ADD COLUMN proxy_seller_api_key TEXT"
            )
            conn.commit()
            log.info("migration_applied", migration="add_proxy_seller_api_key")
    except Exception:  # noqa: BLE001
        log.warning("migration_failed", migration="add_proxy_seller_api_key", exc_info=True)

    # Migration: Stage 3 tables (AI promoter, sales, commenting, auto-replier, templates)
    _stage3_ddl = """
    CREATE TABLE IF NOT EXISTS tg_ai_personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      account_id TEXT REFERENCES tg_accounts(id) ON DELETE SET NULL,
      niche TEXT, bio TEXT, personality TEXT,
      strategy TEXT DEFAULT 'soft', system_prompt TEXT NOT NULL DEFAULT '',
      ai_model TEXT DEFAULT 'claude-haiku-4-5', temperature REAL DEFAULT 0.8,
      target_channels TEXT DEFAULT '[]', schedule TEXT DEFAULT '{}',
      status TEXT DEFAULT 'DRAFT', total_messages INTEGER DEFAULT 0,
      total_leads INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_ai_messages (
      id TEXT PRIMARY KEY,
      persona_id TEXT REFERENCES tg_ai_personas(id) ON DELETE CASCADE,
      chat_id TEXT, chat_title TEXT, reply_to_msg_id INTEGER,
      original_text TEXT, ai_text TEXT NOT NULL, ai_reasoning TEXT,
      status TEXT DEFAULT 'PENDING', sent_at TEXT,
      tg_message_id INTEGER, reactions_count INTEGER DEFAULT 0,
      leads_from_msg INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_ai_msg_persona ON tg_ai_messages(persona_id);
    CREATE INDEX IF NOT EXISTS idx_tg_ai_msg_status ON tg_ai_messages(status);

    CREATE TABLE IF NOT EXISTS tg_sales_scripts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      stages TEXT NOT NULL DEFAULT '[]', system_prompt TEXT NOT NULL DEFAULT '',
      ai_model TEXT DEFAULT 'claude-sonnet-4-6', rag_enabled INTEGER DEFAULT 1,
      rag_doc_ids TEXT DEFAULT '[]', status TEXT DEFAULT 'DRAFT',
      total_dialogs INTEGER DEFAULT 0, total_converted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_sales_dialogs (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES tg_accounts(id) ON DELETE SET NULL,
      script_id TEXT REFERENCES tg_sales_scripts(id) ON DELETE SET NULL,
      contact_user_id INTEGER NOT NULL, contact_username TEXT,
      contact_name TEXT, current_stage TEXT DEFAULT 'intro',
      lead_status TEXT DEFAULT 'NEW', lead_score REAL,
      messages_in INTEGER DEFAULT 0, messages_out INTEGER DEFAULT 0,
      ai_summary TEXT, last_message_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_sales_dlg_status ON tg_sales_dialogs(lead_status);

    CREATE TABLE IF NOT EXISTS tg_sales_messages (
      id TEXT PRIMARY KEY,
      dialog_id TEXT NOT NULL REFERENCES tg_sales_dialogs(id) ON DELETE CASCADE,
      direction TEXT NOT NULL, text TEXT NOT NULL, stage TEXT,
      ai_model TEXT, ai_reasoning TEXT,
      tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_sales_msg_dialog ON tg_sales_messages(dialog_id);

    CREATE TABLE IF NOT EXISTS tg_commenting_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      mode TEXT DEFAULT 'AI', target_channels TEXT DEFAULT '[]',
      account_ids TEXT DEFAULT '[]', trigger_type TEXT DEFAULT 'ALL_POSTS',
      trigger_keywords TEXT, system_prompt TEXT DEFAULT '',
      ai_model TEXT DEFAULT 'claude-haiku-4-5',
      approval_mode TEXT DEFAULT 'AUTO',
      max_per_day INTEGER DEFAULT 10,
      delay_min INTEGER DEFAULT 60, delay_max INTEGER DEFAULT 600,
      status TEXT DEFAULT 'DRAFT',
      total_comments INTEGER DEFAULT 0, total_reactions INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_auto_replier_scenarios (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      account_ids TEXT DEFAULT '[]',
      triggers TEXT NOT NULL DEFAULT '[]',
      default_behavior TEXT DEFAULT 'AI_REPLY',
      active_hours TEXT DEFAULT '09:00-22:00',
      delay_min INTEGER DEFAULT 5, delay_max INTEGER DEFAULT 45,
      status TEXT DEFAULT 'DRAFT', total_replies INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_auto_replies (
      id TEXT PRIMARY KEY,
      scenario_id TEXT REFERENCES tg_auto_replier_scenarios(id) ON DELETE CASCADE,
      account_id TEXT, trigger_name TEXT,
      inbound_text TEXT, response_text TEXT,
      delay_used_sec INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_message_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      category TEXT DEFAULT 'DM', description TEXT,
      tags TEXT DEFAULT '[]', language TEXT DEFAULT 'ru',
      ai_personalization INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE', used_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_template_variants (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES tg_message_templates(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0, text TEXT NOT NULL,
      sent_count INTEGER DEFAULT 0, replied_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_tpl_var_template ON tg_template_variants(template_id);
    """
    try:
        existing_tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        stage3_tables = [
            "tg_ai_personas", "tg_ai_messages", "tg_sales_scripts",
            "tg_sales_dialogs", "tg_sales_messages", "tg_commenting_tasks",
            "tg_auto_replier_scenarios", "tg_auto_replies",
            "tg_message_templates", "tg_template_variants",
        ]
        missing = [t for t in stage3_tables if t not in existing_tables]
        if missing:
            conn.executescript(_stage3_ddl)
            log.info("migration_applied", migration="stage3_tables", tables=missing)
    except Exception:  # noqa: BLE001
        log.warning("migration_failed", migration="stage3_tables", exc_info=True)

    # Migration: Stage 4 tables (DM campaigns, chat broadcasts, invite campaigns)
    _stage4_ddl = """
    CREATE TABLE IF NOT EXISTS tg_dm_campaigns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      audience_id TEXT, template_id TEXT,
      account_ids TEXT DEFAULT '[]',
      distribution TEXT DEFAULT 'ROUND_ROBIN',
      config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'DRAFT',
      total_recipients INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      replied_count INTEGER DEFAULT 0,
      started_at TEXT, paused_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_dm_camp_status ON tg_dm_campaigns(status);

    CREATE TABLE IF NOT EXISTS tg_dm_messages (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES tg_dm_campaigns(id) ON DELETE CASCADE,
      account_id TEXT, recipient_user_id INTEGER,
      recipient_username TEXT, text_sent TEXT,
      variant_index INTEGER, personalized INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PENDING', error_code TEXT,
      sent_at TEXT, replied_at TEXT, reply_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_dm_msg_campaign ON tg_dm_messages(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_tg_dm_msg_status ON tg_dm_messages(status);

    CREATE TABLE IF NOT EXISTS tg_chat_broadcasts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      template_id TEXT, target_channels TEXT DEFAULT '[]',
      account_ids TEXT DEFAULT '[]', config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'DRAFT',
      total_targets INTEGER DEFAULT 0,
      posted_count INTEGER DEFAULT 0,
      deleted_count INTEGER DEFAULT 0,
      banned_count INTEGER DEFAULT 0,
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_chatbr_status ON tg_chat_broadcasts(status);

    CREATE TABLE IF NOT EXISTS tg_chat_broadcast_posts (
      id TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL REFERENCES tg_chat_broadcasts(id) ON DELETE CASCADE,
      account_id TEXT, channel_id TEXT, channel_title TEXT,
      text_posted TEXT, variant_index INTEGER,
      tg_message_id INTEGER,
      status TEXT DEFAULT 'PENDING',
      posted_at TEXT, deleted_at TEXT,
      reactions_count INTEGER DEFAULT 0,
      dm_from_post INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_chatbr_post_br ON tg_chat_broadcast_posts(broadcast_id);

    CREATE TABLE IF NOT EXISTS tg_invite_campaigns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      mode TEXT DEFAULT 'DIRECT',
      target_channel_id TEXT, target_channel_title TEXT,
      audience_id TEXT, account_ids TEXT DEFAULT '[]',
      config TEXT DEFAULT '{}', status TEXT DEFAULT 'DRAFT',
      total_attempts INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      privacy_count INTEGER DEFAULT 0,
      already_count INTEGER DEFAULT 0,
      not_found_count INTEGER DEFAULT 0,
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_inv_camp_status ON tg_invite_campaigns(status);

    CREATE TABLE IF NOT EXISTS tg_invite_attempts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES tg_invite_campaigns(id) ON DELETE CASCADE,
      account_id TEXT, invitee_user_id INTEGER,
      invitee_username TEXT, result TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_inv_att_campaign ON tg_invite_attempts(campaign_id);
    """
    try:
        existing_tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        stage4_tables = [
            "tg_dm_campaigns", "tg_dm_messages", "tg_chat_broadcasts",
            "tg_chat_broadcast_posts", "tg_invite_campaigns", "tg_invite_attempts",
        ]
        missing = [t for t in stage4_tables if t not in existing_tables]
        if missing:
            conn.executescript(_stage4_ddl)
            log.info("migration_applied", migration="stage4_tables", tables=missing)
    except Exception:  # noqa: BLE001
        log.warning("migration_failed", migration="stage4_tables", exc_info=True)

    # Migration: Stage 2 tables (parsing, audiences, channels, phone checker)
    _stage2_ddl = """
    CREATE TABLE IF NOT EXISTS tg_parsing_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'PENDING',
      progress INTEGER DEFAULT 0, total_found INTEGER DEFAULT 0,
      total_filtered INTEGER DEFAULT 0, error_message TEXT,
      audience_id TEXT, celery_task_id TEXT, started_at TEXT,
      finished_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_parsing_status ON tg_parsing_tasks(status);

    CREATE TABLE IF NOT EXISTS tg_audiences (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      source_type TEXT DEFAULT 'PARSED', total_count INTEGER DEFAULT 0,
      unique_count INTEGER DEFAULT 0, tags TEXT DEFAULT '[]',
      metadata TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_audience_members (
      id TEXT PRIMARY KEY,
      audience_id TEXT NOT NULL REFERENCES tg_audiences(id) ON DELETE CASCADE,
      tg_user_id INTEGER, username TEXT, first_name TEXT, last_name TEXT,
      phone TEXT, about TEXT, is_premium INTEGER DEFAULT 0,
      is_bot INTEGER DEFAULT 0, has_avatar INTEGER DEFAULT 0,
      source_chat TEXT, last_seen_at TEXT, country TEXT,
      ai_score REAL, ai_category TEXT, metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_aud_members_audience ON tg_audience_members(audience_id);
    CREATE INDEX IF NOT EXISTS idx_tg_aud_members_user ON tg_audience_members(tg_user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_aud_members_dedup ON tg_audience_members(audience_id, tg_user_id);

    CREATE TABLE IF NOT EXISTS tg_channels (
      id TEXT PRIMARY KEY, tg_id INTEGER UNIQUE, username TEXT,
      title TEXT NOT NULL, about TEXT,
      type TEXT NOT NULL, is_public INTEGER DEFAULT 1,
      members_count INTEGER DEFAULT 0, avg_messages_day REAL,
      category TEXT, tags TEXT DEFAULT '[]', language TEXT,
      role TEXT DEFAULT 'NONE', is_own INTEGER DEFAULT 0,
      last_parsed_at TEXT, metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_channels_username ON tg_channels(username);
    CREATE INDEX IF NOT EXISTS idx_tg_channels_role ON tg_channels(role);

    CREATE TABLE IF NOT EXISTS tg_phone_checks (
      id TEXT PRIMARY KEY, status TEXT DEFAULT 'PENDING',
      input_count INTEGER DEFAULT 0, found_count INTEGER DEFAULT 0,
      premium_count INTEGER DEFAULT 0, started_at TEXT,
      finished_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_phone_check_results (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES tg_phone_checks(id) ON DELETE CASCADE,
      phone TEXT NOT NULL, found INTEGER DEFAULT 0,
      tg_user_id INTEGER, username TEXT, first_name TEXT,
      is_premium INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_phone_results_batch ON tg_phone_check_results(batch_id);
    """
    try:
        existing_tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        stage2_tables = [
            "tg_parsing_tasks", "tg_audiences", "tg_audience_members",
            "tg_channels", "tg_phone_checks", "tg_phone_check_results",
        ]
        missing = [t for t in stage2_tables if t not in existing_tables]
        if missing:
            conn.executescript(_stage2_ddl)
            log.info("migration_applied", migration="stage2_tables", tables=missing)
    except Exception:  # noqa: BLE001
        log.warning("migration_failed", migration="stage2_tables", exc_info=True)

    # Migration: Stage 5 tables (boost, stories boost, cloner, channel creator, converter)
    _stage5_ddl = """
    CREATE TABLE IF NOT EXISTS tg_boost_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      boost_type TEXT NOT NULL,
      target_channel TEXT, target_message_id INTEGER,
      config TEXT DEFAULT '{}',
      target_amount INTEGER DEFAULT 0,
      current_amount INTEGER DEFAULT 0,
      account_ids TEXT DEFAULT '[]',
      status TEXT DEFAULT 'DRAFT',
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_boost_status ON tg_boost_tasks(status);

    CREATE TABLE IF NOT EXISTS tg_boost_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tg_boost_tasks(id) ON DELETE CASCADE,
      account_id TEXT, action_type TEXT NOT NULL,
      success INTEGER DEFAULT 1, error_code TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_boost_act_task ON tg_boost_actions(task_id);

    CREATE TABLE IF NOT EXISTS tg_stories_boost_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      mode TEXT DEFAULT 'MANUAL',
      target_channel TEXT, target_story_id INTEGER,
      config TEXT DEFAULT '{}', account_ids TEXT DEFAULT '[]',
      status TEXT DEFAULT 'DRAFT',
      total_views INTEGER DEFAULT 0, total_reactions INTEGER DEFAULT 0,
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_clone_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      source_channel TEXT NOT NULL, target_channel TEXT NOT NULL,
      copy_items TEXT DEFAULT '["posts"]',
      ai_rewrite INTEGER DEFAULT 0, ai_rewrite_style TEXT,
      schedule_config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'DRAFT',
      total_posts INTEGER DEFAULT 0,
      posted_count INTEGER DEFAULT 0,
      rewritten_count INTEGER DEFAULT 0,
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_channel_creation_tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      channel_type TEXT DEFAULT 'CHANNEL',
      count INTEGER DEFAULT 1,
      naming_pattern TEXT, username_pattern TEXT,
      description TEXT, creator_account_ids TEXT DEFAULT '[]',
      permissions TEXT DEFAULT '{}',
      status TEXT DEFAULT 'DRAFT',
      created_count INTEGER DEFAULT 0,
      created_channel_ids TEXT DEFAULT '[]',
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_conversion_tasks (
      id TEXT PRIMARY KEY, name TEXT,
      input_format TEXT NOT NULL, output_format TEXT NOT NULL,
      files_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'DRAFT',
      errors TEXT DEFAULT '[]',
      started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    """
    try:
        existing_tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        stage5_tables = [
            "tg_boost_tasks", "tg_boost_actions", "tg_stories_boost_tasks",
            "tg_clone_tasks", "tg_channel_creation_tasks", "tg_conversion_tasks",
        ]
        missing = [t for t in stage5_tables if t not in existing_tables]
        if missing:
            conn.executescript(_stage5_ddl)
            log.info("migration_applied", migration="stage5_tables", tables=missing)
    except Exception:  # noqa: BLE001
        log.warning("migration_failed", migration="stage5_tables", exc_info=True)


def get_db(
    workspace_id: str,
    *,
    data_dir: Path | None = None,
    schema_path: Path | None = None,
) -> sqlite3.Connection:
    """Return a cached SQLite connection for *workspace_id*.

    Parameters
    ----------
    workspace_id:
        Logical workspace identifier (used in the DB filename).
    data_dir:
        Override the default ``settings.data_dir`` (useful in tests).
    schema_path:
        Override the default ``schema.sql`` path (useful in tests).
    """
    with _lock:
        if workspace_id in _connections:
            return _connections[workspace_id]

    # Build path outside the lock so IO doesn't block other callers.
    base = data_dir if data_dir is not None else _data_dir()
    base.mkdir(parents=True, exist_ok=True)
    db_path = base / f"ws-{workspace_id}.db"

    is_new = not db_path.exists()

    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")

    if is_new:
        schema = schema_path or _SCHEMA_PATH
        _apply_schema(conn, schema)
        log.info("workspace_db_created", workspace_id=workspace_id, path=str(db_path))
    else:
        _apply_migrations(conn)

    with _lock:
        # Another thread may have raced; prefer the first connection stored.
        if workspace_id in _connections:
            conn.close()
            return _connections[workspace_id]
        _connections[workspace_id] = conn

    return conn


def close_all() -> None:
    """Close every cached connection (call on shutdown)."""
    with _lock:
        for ws_id, conn in _connections.items():
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                log.warning("db_close_error", workspace_id=ws_id, exc_info=True)
        _connections.clear()


def reset_cache() -> None:
    """Drop all cached connections without closing them (for tests only)."""
    with _lock:
        _connections.clear()
