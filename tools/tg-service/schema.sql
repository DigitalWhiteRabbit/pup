-- ============================================================================
-- TG Service — Stage 0 Foundation Schema
-- Per-workspace SQLite database (no workspace_id — entire DB is one workspace)
-- Applied automatically on first request with new workspaceId
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Telegram Accounts Pool ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_accounts (
  id                TEXT PRIMARY KEY,                           -- UUID
  phone             TEXT UNIQUE NOT NULL,
  tg_user_id        INTEGER,                                   -- Telegram bigint user ID
  username          TEXT,
  first_name        TEXT,
  last_name         TEXT,
  about             TEXT,

  -- Session & device fingerprint
  session_path      TEXT NOT NULL,                              -- path to AES-256-GCM encrypted session file
  auth_key_hash     TEXT,
  device_model      TEXT DEFAULT 'iPhone 14 Pro',
  system_version    TEXT DEFAULT 'iOS 17.5.1',
  app_version       TEXT DEFAULT '10.0.0',
  lang_code         TEXT DEFAULT 'ru',
  dc_id             INTEGER,
  country           TEXT,
  country_code      TEXT,
  is_premium        INTEGER DEFAULT 0,                         -- 0/1 boolean

  -- Lifecycle & anti-ban
  status            TEXT DEFAULT 'IMPORTED',                    -- IMPORTED|ACTIVE|WARMING|PAUSED|FLOOD_WAIT|SPAM_BLOCKED|BANNED|DEAD
  warmup_level      INTEGER DEFAULT 0,                         -- 0-100
  warmup_profile    TEXT,                                       -- FRESH|BEGINNER|ACTIVE|EXPERIENCED
  days_active       INTEGER DEFAULT 0,
  last_session_at   TEXT,                                       -- ISO 8601
  banned_at         TEXT,
  ban_reason        TEXT,

  -- Stats
  sent_count        INTEGER DEFAULT 0,                         -- total DMs sent from this account (across all campaigns)

  -- Capabilities (auto-detected restrictions)
  capabilities      TEXT DEFAULT '{}',                          -- JSON: {"can_send_dm":true,"can_search_users":true,"can_get_participants":true,"can_invite":true}

  -- Relations & metadata
  proxy_id          TEXT REFERENCES tg_proxies(id) ON DELETE SET NULL,
  tags              TEXT DEFAULT '[]',                          -- JSON array
  metadata          TEXT,                                       -- JSON object

  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_accounts_status       ON tg_accounts(status);
CREATE INDEX IF NOT EXISTS idx_tg_accounts_phone        ON tg_accounts(phone);
CREATE INDEX IF NOT EXISTS idx_tg_accounts_tg_user_id   ON tg_accounts(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_tg_accounts_proxy_id     ON tg_accounts(proxy_id);
CREATE INDEX IF NOT EXISTS idx_tg_accounts_warmup       ON tg_accounts(warmup_profile, warmup_level);

-- ─── Proxy Pool ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_proxies (
  id                TEXT PRIMARY KEY,                           -- UUID
  provider          TEXT NOT NULL,                              -- e.g. 'manual', 'proxy6'
  provider_order_id TEXT,
  type              TEXT NOT NULL,                              -- RESIDENTIAL|MOBILE|DATACENTER
  scheme            TEXT NOT NULL,                              -- http|socks5|mtproto
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL,
  username          TEXT,
  password          TEXT,
  country           TEXT,
  city              TEXT,

  status            TEXT DEFAULT 'ACTIVE',                      -- ACTIVE|DEAD|PAUSED|EXPIRED
  last_checked_at   TEXT,
  last_latency_ms   INTEGER,
  expires_at        TEXT,
  rotation_url      TEXT,
  metadata          TEXT,                                       -- JSON object

  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),

  UNIQUE(host, port, username)
);

CREATE INDEX IF NOT EXISTS idx_tg_proxies_status  ON tg_proxies(status);
CREATE INDEX IF NOT EXISTS idx_tg_proxies_type    ON tg_proxies(type);
CREATE INDEX IF NOT EXISTS idx_tg_proxies_country ON tg_proxies(country);

-- ─── TG Settings (singleton) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_settings (
  id                            TEXT PRIMARY KEY DEFAULT 'default',

  -- AI configuration
  ai_default_model              TEXT DEFAULT 'claude-haiku-4-5',
  ai_model_roles                TEXT DEFAULT '{}',             -- JSON: { "pitch": "sonnet", "reply": "haiku" }

  -- Per-account daily limits (anti-ban)
  limits_dm_per_day             INTEGER DEFAULT 30,
  limits_chat_posts_per_day     INTEGER DEFAULT 3,
  limits_comments_per_day       INTEGER DEFAULT 10,
  limits_invites_per_day        INTEGER DEFAULT 180,
  limits_subscriptions_per_day  INTEGER DEFAULT 3,

  -- Operational rules
  active_hours                  TEXT DEFAULT '09:00-22:00',
  flood_wait_threshold_min      INTEGER DEFAULT 5,
  emergency_stop_ban_ratio      REAL DEFAULT 0.30,             -- >30% banned accounts → emergency stop
  emergency_stop_delete_ratio   REAL DEFAULT 0.50,             -- >50% message deletes → emergency stop

  -- AI cost control
  ai_monthly_limit_usd          REAL DEFAULT 500.0,
  ai_spent_this_month_usd       REAL DEFAULT 0.0,

  -- Telegram API credentials
  telegram_app_id               INTEGER,
  telegram_app_hash             TEXT,

  -- External API keys (stored encrypted at rest)
  anthropic_api_key             TEXT,

  -- Notification preferences
  notify_on_emergency_stop      INTEGER DEFAULT 1,
  notify_on_spam_block          INTEGER DEFAULT 1,

  -- UI-only settings that have no dedicated column (delays, extra notif flags,
  -- flood-wait behavior, save_snapshot, ...). Stored as a JSON blob so the
  -- settings form persists every field instead of silently dropping unknowns.
  extra_settings                TEXT DEFAULT '{}',

  updated_at                    TEXT DEFAULT (datetime('now'))
);

-- ─── Audit Log ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_audit_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type        TEXT NOT NULL,                              -- e.g. 'account.imported', 'session.decrypted', 'emergency.stop'
  severity          TEXT DEFAULT 'INFO',                        -- DEBUG|INFO|WARN|ERROR|CRITICAL
  entity_type       TEXT,                                       -- e.g. 'account', 'proxy', 'campaign'
  entity_id         TEXT,
  message           TEXT NOT NULL,
  metadata          TEXT,                                       -- JSON object
  ip_address        TEXT,

  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_audit_event_type ON tg_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_tg_audit_severity   ON tg_audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_tg_audit_entity     ON tg_audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tg_audit_created_at ON tg_audit_logs(created_at);

-- ─── Knowledge Base Documents (RAG) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_documents (
  id                TEXT PRIMARY KEY,                           -- UUID
  title             TEXT NOT NULL,
  path              TEXT,                                       -- original file path
  content           TEXT NOT NULL,                              -- full document text
  metadata          TEXT,                                       -- JSON object
  chunks_count      INTEGER DEFAULT 0,

  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- ─── Knowledge Base Chunks (RAG embeddings) ───────────────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_chunks (
  id                TEXT PRIMARY KEY,                           -- UUID
  document_id       TEXT NOT NULL REFERENCES tg_kb_documents(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,                           -- chunk order within document
  text              TEXT NOT NULL,
  embedding         BLOB,                                      -- binary numpy/float32 array

  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_kb_chunks_document ON tg_kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_tg_kb_chunks_position ON tg_kb_chunks(document_id, position);

-- ─── Knowledge Base Crawl Jobs (website crawler) ──────────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_crawl_jobs (
  id                TEXT PRIMARY KEY,                           -- UUID
  url               TEXT NOT NULL,                              -- start URL
  status            TEXT DEFAULT 'PENDING',                     -- PENDING|RUNNING|DONE|FAILED
  pages_found       INTEGER DEFAULT 0,                          -- queued + visited
  pages_done        INTEGER DEFAULT 0,                          -- pages fetched/processed
  documents_created INTEGER DEFAULT 0,                          -- KB docs saved
  error             TEXT,                                       -- failure / safety-cap note
  started_at        TEXT,
  finished_at       TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_kb_crawl_jobs_status ON tg_kb_crawl_jobs(status);

-- ─── Knowledge Base Conflicts (consistency check) ─────────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_conflicts (
  id            TEXT PRIMARY KEY,                           -- UUID
  conflict_type TEXT NOT NULL,                              -- 'duplicate' | 'contradiction'
  doc_a_id      TEXT,
  doc_a_title   TEXT,
  doc_b_id      TEXT,
  doc_b_title   TEXT,
  summary       TEXT,                                       -- short human description (RU)
  quote_a       TEXT,                                       -- conflicting/duplicate snippet A
  quote_b       TEXT,                                       -- conflicting/duplicate snippet B
  conflict_field TEXT,                                      -- contradiction: differing field (RU), null for duplicates
  value_a       TEXT,                                       -- contradiction: doc A's value, null for duplicates
  value_b       TEXT,                                       -- contradiction: doc B's value, null for duplicates
  status        TEXT DEFAULT 'open',                        -- open | resolved | dismissed
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_kb_conflicts_status ON tg_kb_conflicts(status);

-- ─── Knowledge Base Test-Chat (RAG dialog history) ────────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_chat_messages (
  id            TEXT PRIMARY KEY,                           -- UUID
  role          TEXT NOT NULL,                              -- 'user' | 'assistant'
  content       TEXT NOT NULL,
  sources       TEXT,                                       -- JSON array (assistant): [{doc_id,title,url,snippet}]
  mode          TEXT,                                       -- 'strict' | 'free' (mode used for the answer)
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_kb_chat_messages_created ON tg_kb_chat_messages(created_at);

-- ─── Knowledge Base Self-Test (auto QA coverage runs) ─────────────────────

CREATE TABLE IF NOT EXISTS tg_kb_selftest_runs (
  id            TEXT PRIMARY KEY,                           -- UUID
  status        TEXT DEFAULT 'PENDING',                     -- PENDING|RUNNING|DONE|FAILED
  total         INTEGER DEFAULT 0,                          -- control questions generated
  answered      INTEGER DEFAULT 0,                          -- questions answered from the base
  gaps          INTEGER DEFAULT 0,                          -- total - answered
  results       TEXT,                                       -- JSON: [{question,answer,answered,verdict}]
  summary       TEXT,                                       -- short RU summary
  error         TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_kb_selftest_runs_created ON tg_kb_selftest_runs(created_at);

-- ─── Generic Key-Value Settings ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  key               TEXT PRIMARY KEY,
  value             TEXT,
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- ─── Warmup Actions Log ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_warmup_actions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
  action_type       TEXT NOT NULL,          -- READ_CHATS|REACT_POST|SHORT_REPLY|SUBSCRIBE_CHANNEL|UPDATE_PROFILE|POST_STORY
  target_type       TEXT,                    -- channel|post|story
  target_id         TEXT,
  success           INTEGER DEFAULT 1,
  error_code        TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_warmup_account_time ON tg_warmup_actions(account_id, created_at);

-- ─── Parsing Tasks ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_parsing_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL,  -- CHAT_MEMBERS|COMMENTERS|WRITERS|REACTIONS|POLLS|JOINERS|TOPICS|GLOBAL_SEARCH
  config          TEXT NOT NULL DEFAULT '{}',  -- JSON: sources, filters, threads count etc.

  status          TEXT DEFAULT 'PENDING',  -- PENDING|RUNNING|PAUSED|COMPLETED|FAILED|CANCELLED
  progress        INTEGER DEFAULT 0,  -- 0-100
  total_found     INTEGER DEFAULT 0,
  total_filtered  INTEGER DEFAULT 0,
  error_message   TEXT,

  audience_id     TEXT,  -- FK to output audience
  celery_task_id  TEXT,  -- Celery async task ID

  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_parsing_status ON tg_parsing_tasks(status);

-- ─── Audiences (parsed contact databases) ────────────────────────────

CREATE TABLE IF NOT EXISTS tg_audiences (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  source_type     TEXT DEFAULT 'PARSED',  -- PARSED|IMPORTED|MERGED|FILTERED

  total_count     INTEGER DEFAULT 0,
  unique_count    INTEGER DEFAULT 0,

  tags            TEXT DEFAULT '[]',
  metadata        TEXT,

  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Audience Members ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_audience_members (
  id              TEXT PRIMARY KEY,
  audience_id     TEXT NOT NULL REFERENCES tg_audiences(id) ON DELETE CASCADE,

  tg_user_id      INTEGER,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  phone           TEXT,
  about           TEXT,

  is_premium      INTEGER DEFAULT 0,
  is_bot          INTEGER DEFAULT 0,
  has_avatar      INTEGER DEFAULT 0,

  source_chat     TEXT,
  last_seen_at    TEXT,
  country         TEXT,

  ai_score        REAL,
  ai_category     TEXT,  -- HIGH|MEDIUM|LOW|IRRELEVANT

  metadata        TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_aud_members_audience ON tg_audience_members(audience_id);
CREATE INDEX IF NOT EXISTS idx_tg_aud_members_user ON tg_audience_members(tg_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_aud_members_dedup ON tg_audience_members(audience_id, tg_user_id);

-- ─── Channels Database ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_channels (
  id              TEXT PRIMARY KEY,
  tg_id           INTEGER UNIQUE,
  username        TEXT,
  title           TEXT NOT NULL,
  about           TEXT,
  type            TEXT NOT NULL,  -- CHANNEL|SUPERGROUP|BASIC_GROUP|FORUM
  is_public       INTEGER DEFAULT 1,

  members_count   INTEGER DEFAULT 0,
  avg_messages_day REAL,

  category        TEXT,
  tags            TEXT DEFAULT '[]',
  language        TEXT,

  role            TEXT DEFAULT 'NONE',  -- SOURCE|TARGET|BOTH|NONE
  is_own          INTEGER DEFAULT 0,

  last_parsed_at  TEXT,
  metadata        TEXT,

  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_channels_username ON tg_channels(username);
CREATE INDEX IF NOT EXISTS idx_tg_channels_role ON tg_channels(role);

-- ─── Phone Check Batches ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tg_phone_checks (
  id              TEXT PRIMARY KEY,
  status          TEXT DEFAULT 'PENDING',
  input_count     INTEGER DEFAULT 0,
  found_count     INTEGER DEFAULT 0,
  premium_count   INTEGER DEFAULT 0,

  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tg_phone_check_results (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES tg_phone_checks(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  found           INTEGER DEFAULT 0,
  tg_user_id      INTEGER,
  username        TEXT,
  first_name      TEXT,
  is_premium      INTEGER DEFAULT 0,

  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tg_phone_results_batch ON tg_phone_check_results(batch_id);

-- ─── AI Agent Personas ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_ai_personas (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  account_ids     TEXT DEFAULT '[]',                              -- JSON array of account IDs (one persona → many accounts)
  niche           TEXT,
  bio             TEXT,
  personality     TEXT,
  strategy        TEXT DEFAULT 'soft',                            -- soft|medium|aggressive
  system_prompt   TEXT NOT NULL DEFAULT '',
  ai_model        TEXT DEFAULT 'claude-haiku-4-5',
  temperature     REAL DEFAULT 0.8,
  target_channels TEXT DEFAULT '[]',                              -- JSON array of channel IDs/usernames
  rag_doc_ids     TEXT DEFAULT '[]',                              -- JSON array of KB document IDs for RAG
  schedule        TEXT DEFAULT '{}',                              -- JSON: active_hours, max_messages_day
  dm_enabled      INTEGER DEFAULT 1,                              -- 0/1: can agent initiate DMs from chat?
  context_depth   INTEGER DEFAULT 50,                             -- how many chat messages to read for context
  style_topic     TEXT DEFAULT 'общее',                           -- style-bank topic to draw examples from
  status          TEXT DEFAULT 'DRAFT',                           -- DRAFT|ACTIVE|PAUSED
  total_messages  INTEGER DEFAULT 0,
  total_leads     INTEGER DEFAULT 0,
  total_dm_sent   INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── AI Messages (promoter outbox) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_ai_messages (
  id              TEXT PRIMARY KEY,
  persona_id      TEXT REFERENCES tg_ai_personas(id) ON DELETE CASCADE,
  arena_id        TEXT,  -- non-null when message was produced inside an Agent Arena (self-play)
  chat_id         TEXT,
  chat_title      TEXT,
  reply_to_msg_id INTEGER,
  original_text   TEXT,  -- message AI is replying to
  ai_text         TEXT NOT NULL,
  ai_reasoning    TEXT,
  status          TEXT DEFAULT 'PENDING',  -- PENDING|APPROVED|SENT|REJECTED|FAILED
  sent_at         TEXT,
  tg_message_id   INTEGER,
  reactions_count INTEGER DEFAULT 0,
  leads_from_msg  INTEGER DEFAULT 0,
  moderator_rating TEXT,  -- NULL|good|bad — human moderator feedback (self-learning)
  moderator_note  TEXT,   -- optional moderator note (anti-pattern tip when 'bad')
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_ai_msg_persona ON tg_ai_messages(persona_id);
CREATE INDEX IF NOT EXISTS idx_tg_ai_msg_status ON tg_ai_messages(status);
CREATE INDEX IF NOT EXISTS idx_tg_ai_msg_arena ON tg_ai_messages(arena_id);

-- ─── Agent Arenas (multi-agent self-play → training corpus) ──────────
-- N personas talk to each other in one real private TG group; moderator-
-- approved (👍) snippets become style-bank training corpus. See ARENA_SPEC.md.
CREATE TABLE IF NOT EXISTS tg_agent_arenas (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  chat_id         TEXT,                          -- TG group (Bruno provides id/@username/link → resolved)
  chat_title      TEXT,
  persona_ids     TEXT DEFAULT '[]',             -- JSON: 2–4 participating personas
  mode            TEXT DEFAULT 'casual',         -- casual | sales
  topic           TEXT,                          -- seed topic / scenario
  sales_config    TEXT,                          -- JSON (sales mode): seller persona, lead personas, objections
  cadence_sec     INTEGER DEFAULT 120,           -- pause between turns (ticks)
  max_msgs_day    INTEGER DEFAULT 100,           -- daily message cap for the arena
  turn_order      TEXT DEFAULT '[]',             -- JSON: round-robin persona order
  next_turn_idx   INTEGER DEFAULT 0,             -- whose turn is next
  status          TEXT DEFAULT 'DRAFT',          -- DRAFT | RUNNING | PAUSED | STOPPED
  total_msgs      INTEGER DEFAULT 0,
  total_harvested INTEGER DEFAULT 0,             -- snippets approved into the corpus
  loop_token      TEXT,                          -- nonce minted on start; tick reschedules only if it still matches (kills duplicate loops)
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_arena_status ON tg_agent_arenas(status);

-- ─── Sales Scripts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_sales_scripts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  stages          TEXT NOT NULL DEFAULT '[]',  -- JSON array of stage objects
  system_prompt   TEXT NOT NULL DEFAULT '',
  ai_model        TEXT DEFAULT 'claude-sonnet-4-6',
  rag_enabled     INTEGER DEFAULT 1,
  rag_doc_ids     TEXT DEFAULT '[]',  -- JSON array
  status          TEXT DEFAULT 'DRAFT',  -- DRAFT|ACTIVE|PAUSED
  total_dialogs   INTEGER DEFAULT 0,
  total_converted INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Sales Dialogs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_sales_dialogs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES tg_accounts(id) ON DELETE SET NULL,
  script_id       TEXT REFERENCES tg_sales_scripts(id) ON DELETE SET NULL,
  contact_user_id INTEGER NOT NULL,
  contact_username TEXT,
  contact_name    TEXT,
  current_stage   TEXT DEFAULT 'intro',
  lead_status     TEXT DEFAULT 'NEW',  -- NEW|ENGAGING|QUALIFIED|PROPOSAL|CONVERTED|LOST|HANDED_OFF
  lead_score      REAL,
  messages_in     INTEGER DEFAULT 0,
  messages_out    INTEGER DEFAULT 0,
  ai_summary      TEXT,
  last_message_at TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_sales_dlg_status ON tg_sales_dialogs(lead_status);

-- ─── Sales Messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_sales_messages (
  id              TEXT PRIMARY KEY,
  dialog_id       TEXT NOT NULL REFERENCES tg_sales_dialogs(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,  -- INBOUND|OUTBOUND
  text            TEXT NOT NULL,
  stage           TEXT,
  ai_model        TEXT,
  ai_reasoning    TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_sales_msg_dialog ON tg_sales_messages(dialog_id);

-- ─── Universal DM Threads ────────────────────────────────────────────
-- Per (account, peer) thread state for the universal AI secretary mode:
-- agent reads ALL DMs of an account (not just sales leads), keeps a rolling
-- summary so it always knows the gist of every conversation, and can be
-- muted per-thread (whitelist of skips). Independent from tg_sales_dialogs:
-- a thread can exist without a sales_dialog (universal mode) or alongside
-- one (sales lead — sales-flow takes precedence, this row still tracks
-- mute + summary for the messenger UI).
CREATE TABLE IF NOT EXISTS tg_dm_threads (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
  peer_id                  INTEGER NOT NULL,           -- TG user id of the other side
  peer_username            TEXT,
  peer_name                TEXT,
  summary                  TEXT,                       -- rolling, AI-generated gist of the conversation
  last_summarized_msg_id   INTEGER,                    -- highest TG msg id already folded into summary
  msgs_since_summary       INTEGER DEFAULT 0,          -- new incoming msgs since last summary refresh
  last_replied_at          TEXT,                       -- when WE last replied
  last_msg_at              TEXT,                       -- when the latest msg in this thread arrived
  muted                    INTEGER DEFAULT 0,          -- 0/1: skip agent replies entirely
  mute_reason              TEXT,
  total_in                 INTEGER DEFAULT 0,
  total_out                INTEGER DEFAULT 0,
  metadata                 TEXT,                       -- JSON: tags, custom
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_tg_dm_threads_account  ON tg_dm_threads(account_id);
CREATE INDEX IF NOT EXISTS idx_tg_dm_threads_muted    ON tg_dm_threads(muted);
CREATE INDEX IF NOT EXISTS idx_tg_dm_threads_lastmsg  ON tg_dm_threads(account_id, last_msg_at);

-- ─── Commenting Tasks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_commenting_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT DEFAULT 'AI',  -- AI|TEMPLATES|MIXED
  target_channels TEXT DEFAULT '[]',  -- JSON
  account_ids     TEXT DEFAULT '[]',
  trigger_type    TEXT DEFAULT 'ALL_POSTS',  -- ALL_POSTS|KEYWORDS|MANUAL
  trigger_keywords TEXT,
  system_prompt   TEXT DEFAULT '',
  ai_model        TEXT DEFAULT 'claude-haiku-4-5',
  approval_mode   TEXT DEFAULT 'AUTO',  -- AUTO|ALL|IMPORTANT
  max_per_day     INTEGER DEFAULT 10,
  delay_min       INTEGER DEFAULT 60,
  delay_max       INTEGER DEFAULT 600,
  status          TEXT DEFAULT 'DRAFT',
  total_comments  INTEGER DEFAULT 0,
  total_reactions INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Commenting Log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_commenting_log (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tg_commenting_tasks(id) ON DELETE CASCADE,
  account_id      TEXT,
  channel_id      TEXT,
  channel_title   TEXT,
  post_id         INTEGER,
  post_text       TEXT,
  comment_text    TEXT,
  ai_model        TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  status          TEXT DEFAULT 'PENDING',  -- PENDING|SENT|FAILED|REJECTED
  tg_message_id   INTEGER,
  sent_at         TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_comm_log_task ON tg_commenting_log(task_id);
CREATE INDEX IF NOT EXISTS idx_tg_comm_log_account_date ON tg_commenting_log(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tg_comm_log_status ON tg_commenting_log(status);

-- ─── Auto-Replier Scenarios ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_auto_replier_scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  account_ids     TEXT DEFAULT '[]',
  triggers        TEXT NOT NULL DEFAULT '[]',  -- JSON array of trigger objects
  default_behavior TEXT DEFAULT 'AI_REPLY',  -- AI_REPLY|TEMPLATE|SILENCE|NOTIFY|HANDOFF_SALES
  active_hours    TEXT DEFAULT '09:00-22:00',
  delay_min       INTEGER DEFAULT 5,
  delay_max       INTEGER DEFAULT 45,
  status          TEXT DEFAULT 'DRAFT',
  total_replies   INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Auto-Replies Log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_auto_replies (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT REFERENCES tg_auto_replier_scenarios(id) ON DELETE CASCADE,
  account_id      TEXT,
  trigger_name    TEXT,
  inbound_text    TEXT,
  response_text   TEXT,
  delay_used_sec  INTEGER,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Message Templates ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_message_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT DEFAULT 'DM',  -- DM|CHAT_POST|COMMENT|AUTO_REPLY|WELCOME
  description     TEXT,
  tags            TEXT DEFAULT '[]',
  language        TEXT DEFAULT 'ru',
  ai_personalization INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'ACTIVE',  -- ACTIVE|DRAFT|ARCHIVED
  used_count      INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Template Variants (spinning) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_template_variants (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES tg_message_templates(id) ON DELETE CASCADE,
  position        INTEGER DEFAULT 0,
  text            TEXT NOT NULL,
  sent_count      INTEGER DEFAULT 0,
  replied_count   INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_tpl_var_template ON tg_template_variants(template_id);

-- ─── DM Campaigns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_dm_campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  audience_id     TEXT,
  template_id     TEXT,
  account_ids     TEXT DEFAULT '[]',
  distribution    TEXT DEFAULT 'ROUND_ROBIN',  -- ROUND_ROBIN|GEO_MATCHED|RANDOM
  config          TEXT DEFAULT '{}',  -- JSON: delay_min/max, ramp_up, ai_personalization, etc.
  status          TEXT DEFAULT 'DRAFT',  -- DRAFT|SCHEDULED|RUNNING|PAUSED|COMPLETED|STOPPED|EMERGENCY_STOPPED
  total_recipients INTEGER DEFAULT 0,
  sent_count      INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  replied_count   INTEGER DEFAULT 0,
  started_at      TEXT,
  paused_at       TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_dm_camp_status ON tg_dm_campaigns(status);

-- ─── DM Campaign Messages ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_dm_messages (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES tg_dm_campaigns(id) ON DELETE CASCADE,
  account_id      TEXT,
  recipient_user_id INTEGER,
  recipient_username TEXT,
  text_sent       TEXT,
  variant_index   INTEGER,
  personalized    INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'PENDING',  -- PENDING|SENT|FAILED|REPLIED|SKIPPED
  error_code      TEXT,
  sent_at         TEXT,
  replied_at      TEXT,
  reply_text      TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_dm_msg_campaign ON tg_dm_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_tg_dm_msg_status ON tg_dm_messages(status);

-- ─── Chat Broadcast Campaigns ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_chat_broadcasts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  template_id     TEXT,
  target_channels TEXT DEFAULT '[]',
  account_ids     TEXT DEFAULT '[]',
  config          TEXT DEFAULT '{}',
  status          TEXT DEFAULT 'DRAFT',
  total_targets   INTEGER DEFAULT 0,
  posted_count    INTEGER DEFAULT 0,
  deleted_count   INTEGER DEFAULT 0,
  banned_count    INTEGER DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_chatbr_status ON tg_chat_broadcasts(status);

-- ─── Chat Broadcast Posts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_chat_broadcast_posts (
  id              TEXT PRIMARY KEY,
  broadcast_id    TEXT NOT NULL REFERENCES tg_chat_broadcasts(id) ON DELETE CASCADE,
  account_id      TEXT,
  channel_id      TEXT,
  channel_title   TEXT,
  text_posted     TEXT,
  variant_index   INTEGER,
  tg_message_id   INTEGER,
  status          TEXT DEFAULT 'PENDING',  -- PENDING|POSTED|DELETED_BY_MODS|BANNED_IN_CHAT|FAILED|SLOW_MODE
  posted_at       TEXT,
  deleted_at      TEXT,
  reactions_count INTEGER DEFAULT 0,
  dm_from_post    INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_chatbr_post_br ON tg_chat_broadcast_posts(broadcast_id);

-- ─── Invite Campaigns ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_invite_campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT DEFAULT 'DIRECT',  -- DIRECT|INVITE_LINK
  target_channel_id TEXT,
  target_channel_title TEXT,
  audience_id     TEXT,
  account_ids     TEXT DEFAULT '[]',
  config          TEXT DEFAULT '{}',
  status          TEXT DEFAULT 'DRAFT',
  total_attempts  INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  privacy_count   INTEGER DEFAULT 0,
  already_count   INTEGER DEFAULT 0,
  not_found_count INTEGER DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_inv_camp_status ON tg_invite_campaigns(status);

-- ─── Invite Attempts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_invite_attempts (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES tg_invite_campaigns(id) ON DELETE CASCADE,
  account_id      TEXT,
  invitee_user_id INTEGER,
  invitee_username TEXT,
  result          TEXT NOT NULL,  -- SUCCESS|PRIVACY_RESTRICTED|ALREADY_PARTICIPANT|USER_NOT_FOUND|PEER_FLOOD|FAILED
  error_code      TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_inv_att_campaign ON tg_invite_attempts(campaign_id);

-- ─── Boost Tasks (subscribers, reactions, views, votes) ──────────────
CREATE TABLE IF NOT EXISTS tg_boost_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  boost_type      TEXT NOT NULL,  -- SUBSCRIBERS|REACTIONS|VIEWS|POLL_VOTES
  target_channel  TEXT,
  target_message_id INTEGER,
  config          TEXT DEFAULT '{}',  -- JSON: natural_curve, distribution, emoji for reactions
  target_amount   INTEGER DEFAULT 0,
  current_amount  INTEGER DEFAULT 0,
  account_ids     TEXT DEFAULT '[]',
  status          TEXT DEFAULT 'DRAFT',
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_boost_status ON tg_boost_tasks(status);

-- ─── Boost Actions Log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_boost_actions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tg_boost_tasks(id) ON DELETE CASCADE,
  account_id      TEXT,
  action_type     TEXT NOT NULL,  -- subscribe|react|view|vote
  success         INTEGER DEFAULT 1,
  error_code      TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_boost_act_task ON tg_boost_actions(task_id);

-- ─── Stories Boost Tasks ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_stories_boost_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT DEFAULT 'MANUAL',  -- AUTO_MONITOR|MANUAL
  target_channel  TEXT,
  target_story_id INTEGER,
  config          TEXT DEFAULT '{}',
  account_ids     TEXT DEFAULT '[]',
  status          TEXT DEFAULT 'DRAFT',
  total_views     INTEGER DEFAULT 0,
  total_reactions INTEGER DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Clone Tasks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_clone_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_channel  TEXT NOT NULL,
  target_channel  TEXT NOT NULL,
  copy_items      TEXT DEFAULT '["posts"]',  -- JSON: posts|profile|avatar|pinned
  ai_rewrite      INTEGER DEFAULT 0,
  ai_rewrite_style TEXT,
  schedule_config TEXT DEFAULT '{}',
  status          TEXT DEFAULT 'DRAFT',
  total_posts     INTEGER DEFAULT 0,
  posted_count    INTEGER DEFAULT 0,
  rewritten_count INTEGER DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Channel Creation Tasks ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_channel_creation_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  channel_type    TEXT DEFAULT 'CHANNEL',  -- CHANNEL|SUPERGROUP|BASIC_GROUP
  count           INTEGER DEFAULT 1,
  naming_pattern  TEXT,
  username_pattern TEXT,
  description     TEXT,
  creator_account_ids TEXT DEFAULT '[]',
  permissions     TEXT DEFAULT '{}',
  status          TEXT DEFAULT 'DRAFT',
  created_count   INTEGER DEFAULT 0,
  created_channel_ids TEXT DEFAULT '[]',
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Format Conversion Tasks ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_conversion_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  input_format    TEXT NOT NULL,  -- TDATA|SESSION|SESSION_JSON
  output_format   TEXT NOT NULL,
  files_count     INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'DRAFT',
  errors          TEXT DEFAULT '[]',
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Join Chat Tasks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_join_tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  target_chats    TEXT NOT NULL DEFAULT '[]',   -- JSON array of chat links/usernames
  account_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array of account IDs
  join_interval_min INTEGER DEFAULT 30,         -- min seconds between joins
  join_interval_max INTEGER DEFAULT 120,        -- max seconds between joins
  config          TEXT DEFAULT '{}',            -- JSON: daily_limit, ban_auto_stop_count, etc.
  status          TEXT DEFAULT 'PENDING',       -- PENDING|RUNNING|COMPLETED|FAILED|STOPPED
  total_joins     INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  results         TEXT DEFAULT '[]',            -- JSON array of {account_id, chat, status, error, chat_title, chat_about}
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_join_tasks_status ON tg_join_tasks(status);

-- ─── Warmup Scripts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_warmup_scripts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  actions         TEXT NOT NULL DEFAULT '[]',   -- JSON array of action objects
  target_channels TEXT DEFAULT '[]',            -- JSON array of channels for subscribe/react/comment actions
  status          TEXT DEFAULT 'ACTIVE',        -- ACTIVE|ARCHIVED
  total_runs      INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── Warmup Script Runs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_warmup_runs (
  id              TEXT PRIMARY KEY,
  script_id       TEXT REFERENCES tg_warmup_scripts(id) ON DELETE CASCADE,
  account_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array of account IDs
  status          TEXT DEFAULT 'PENDING',       -- PENDING|RUNNING|COMPLETED|FAILED
  results         TEXT DEFAULT '[]',            -- JSON array of per-account results
  total_actions   INTEGER DEFAULT 0,
  success_count   INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_warmup_runs_script ON tg_warmup_runs(script_id);
CREATE INDEX IF NOT EXISTS idx_tg_warmup_runs_status ON tg_warmup_runs(status);

-- ============================================================================
-- Default data
-- ============================================================================

INSERT OR IGNORE INTO tg_settings (id) VALUES ('default');
