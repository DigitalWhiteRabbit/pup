-- ─── Projects ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  unique_selling_points TEXT,
  target_audience TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  ad_formats TEXT,
  language TEXT DEFAULT 'ru',
  is_active INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Leads ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT,
  channel_url TEXT,
  thumbnail TEXT,
  country TEXT,
  subscribers INTEGER,
  avg_views INTEGER,
  engagement_rate REAL,
  email TEXT,
  telegram TEXT,
  whatsapp TEXT,
  raw_contacts TEXT,
  keyword TEXT,
  lead_status TEXT DEFAULT 'pending',
  dialogue_stage TEXT DEFAULT 'not_contacted',
  project_id INTEGER,
  agreed_price INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status, dialogue_stage);
CREATE INDEX IF NOT EXISTS idx_leads_project ON leads(project_id);

-- ─── Dialogues ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dialogues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  external_thread_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_dialogues_lead ON dialogues(lead_id);

-- ─── Messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dialogue_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(dialogue_id) REFERENCES dialogues(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_dialogue ON messages(dialogue_id);

-- ─── Deals ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  proposed_price INTEGER,
  agent_summary TEXT,
  admin_decision TEXT,
  admin_notes TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY(lead_id) REFERENCES leads(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- ─── Consultations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  question TEXT NOT NULL,
  context TEXT,
  admin_response TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  answered_at TEXT,
  FOREIGN KEY(lead_id) REFERENCES leads(id)
);

-- ─── Settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
