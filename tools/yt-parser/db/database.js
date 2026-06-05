const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const DATA_DIR = path.join(__dirname, "..", "data");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Per-workspace database cache ──────────────────────────────────
const databases = new Map();

function getDb(workspaceId = "default") {
  if (databases.has(workspaceId)) return databases.get(workspaceId);

  const dbPath = path.join(DATA_DIR, `ws-${workspaceId}.db`);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply schema
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);

  // ─── Migrations (idempotent) ──────────────────────────────────────
  function columnExists(table, column) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      return cols.some((c) => c.name === column);
    } catch {
      return false;
    }
  }
  function safeExec(sql) {
    try {
      db.exec(sql);
    } catch (e) {
      console.error(`[migrate][ws:${workspaceId}]`, sql, e.message);
    }
  }

  if (!columnExists("leads", "locked_until"))
    safeExec(`ALTER TABLE leads ADD COLUMN locked_until INTEGER`);
  if (!columnExists("dialogues", "message_count"))
    safeExec(
      `ALTER TABLE dialogues ADD COLUMN message_count INTEGER DEFAULT 0`,
    );
  if (!columnExists("leads", "content_summary"))
    safeExec(`ALTER TABLE leads ADD COLUMN content_summary TEXT`);
  if (!columnExists("leads", "followup_attempts"))
    safeExec(
      `ALTER TABLE leads ADD COLUMN followup_attempts INTEGER DEFAULT 0`,
    );
  if (!columnExists("leads", "last_followup_at"))
    safeExec(`ALTER TABLE leads ADD COLUMN last_followup_at TEXT`);
  if (!columnExists("leads", "last_videos_json"))
    safeExec(`ALTER TABLE leads ADD COLUMN last_videos_json TEXT`);
  if (!columnExists("leads", "channel_about_text"))
    safeExec(`ALTER TABLE leads ADD COLUMN channel_about_text TEXT`);
  if (!columnExists("leads", "channel_tags"))
    safeExec(`ALTER TABLE leads ADD COLUMN channel_tags TEXT`);
  if (!columnExists("leads", "top_playlists_json"))
    safeExec(`ALTER TABLE leads ADD COLUMN top_playlists_json TEXT`);
  if (!columnExists("leads", "channel_age_days"))
    safeExec(`ALTER TABLE leads ADD COLUMN channel_age_days INTEGER`);
  if (!columnExists("leads", "channel_language"))
    safeExec(`ALTER TABLE leads ADD COLUMN channel_language TEXT`);
  if (!columnExists("leads", "main_category"))
    safeExec(`ALTER TABLE leads ADD COLUMN main_category TEXT`);
  if (!columnExists("leads", "er_normalized"))
    safeExec(`ALTER TABLE leads ADD COLUMN er_normalized REAL`);
  if (!columnExists("leads", "er_flags"))
    safeExec(`ALTER TABLE leads ADD COLUMN er_flags TEXT`);
  if (!columnExists("leads", "enriched_at"))
    safeExec(`ALTER TABLE leads ADD COLUMN enriched_at TEXT`);
  if (!columnExists("leads", "is_deep_summary"))
    safeExec(`ALTER TABLE leads ADD COLUMN is_deep_summary INTEGER DEFAULT 0`);
  if (!columnExists("projects", "ideal_channel_profile"))
    safeExec(`ALTER TABLE projects ADD COLUMN ideal_channel_profile TEXT`);
  if (!columnExists("projects", "bad_fit_examples"))
    safeExec(`ALTER TABLE projects ADD COLUMN bad_fit_examples TEXT`);
  if (!columnExists("projects", "proof_points"))
    safeExec(`ALTER TABLE projects ADD COLUMN proof_points TEXT`);
  if (!columnExists("projects", "value_prop_short"))
    safeExec(`ALTER TABLE projects ADD COLUMN value_prop_short TEXT`);
  if (!columnExists("projects", "signature"))
    safeExec(`ALTER TABLE projects ADD COLUMN signature TEXT`);
  if (!columnExists("projects", "cta_text"))
    safeExec(`ALTER TABLE projects ADD COLUMN cta_text TEXT`);
  if (!columnExists("projects", "cta_link"))
    safeExec(`ALTER TABLE projects ADD COLUMN cta_link TEXT`);
  if (!columnExists("projects", "creator_economics"))
    safeExec(`ALTER TABLE projects ADD COLUMN creator_economics TEXT`);
  if (!columnExists("projects", "tone_of_voice"))
    safeExec(`ALTER TABLE projects ADD COLUMN tone_of_voice TEXT`);
  if (!columnExists("projects", "stop_words"))
    safeExec(`ALTER TABLE projects ADD COLUMN stop_words TEXT`);
  if (!columnExists("projects", "agent_persona"))
    safeExec(`ALTER TABLE projects ADD COLUMN agent_persona TEXT`);
  if (!columnExists("projects", "sample_pitches"))
    safeExec(`ALTER TABLE projects ADD COLUMN sample_pitches TEXT`);
  if (!columnExists("projects", "content_red_flags"))
    safeExec(`ALTER TABLE projects ADD COLUMN content_red_flags TEXT`);
  if (!columnExists("projects", "admin_directive"))
    safeExec(`ALTER TABLE projects ADD COLUMN admin_directive TEXT`);
  if (!columnExists("projects", "system_prompt"))
    safeExec(`ALTER TABLE projects ADD COLUMN system_prompt TEXT`);
  if (!columnExists("projects", "reply_delay_min"))
    safeExec(
      `ALTER TABLE projects ADD COLUMN reply_delay_min INTEGER DEFAULT 30`,
    );
  if (!columnExists("projects", "reply_delay_max"))
    safeExec(
      `ALTER TABLE projects ADD COLUMN reply_delay_max INTEGER DEFAULT 90`,
    );
  if (!columnExists("pending_replies", "send_after"))
    safeExec(`ALTER TABLE pending_replies ADD COLUMN send_after TEXT`);

  // Seed: default red_flags for project CopyBanner (id=3) — only for default workspace
  if (workspaceId === "default") {
    try {
      const _proj = db
        .prepare(`SELECT content_red_flags FROM projects WHERE id = 3`)
        .get();
      if (_proj && _proj.content_red_flags == null) {
        db.prepare(
          `UPDATE projects SET content_red_flags = ?, updated_at = ? WHERE id = 3`,
        ).run(
          "политический контент, 18+, детский контент без COPPA, накрутка просмотров, низкое качество видео",
          new Date().toISOString(),
        );
        console.log(
          `[migrate][ws:${workspaceId}] content_red_flags seed: project id=3`,
        );
      }
    } catch (e) {
      console.error(
        `[migrate][ws:${workspaceId}] content_red_flags seed:`,
        e.message,
      );
    }
  }

  // Lead-scoring & Shorts intelligence
  if (!columnExists("leads", "lead_score"))
    safeExec(`ALTER TABLE leads ADD COLUMN lead_score INTEGER`);
  if (!columnExists("leads", "score_breakdown"))
    safeExec(`ALTER TABLE leads ADD COLUMN score_breakdown TEXT`);
  if (!columnExists("leads", "shorts_count"))
    safeExec(`ALTER TABLE leads ADD COLUMN shorts_count INTEGER`);
  if (!columnExists("leads", "shorts_ratio"))
    safeExec(`ALTER TABLE leads ADD COLUMN shorts_ratio REAL`);
  if (!columnExists("leads", "shorts_avg_views"))
    safeExec(`ALTER TABLE leads ADD COLUMN shorts_avg_views INTEGER`);
  if (!columnExists("leads", "long_avg_views"))
    safeExec(`ALTER TABLE leads ADD COLUMN long_avg_views INTEGER`);
  if (!columnExists("leads", "posting_frequency"))
    safeExec(`ALTER TABLE leads ADD COLUMN posting_frequency REAL`);
  if (!columnExists("leads", "scored_at"))
    safeExec(`ALTER TABLE leads ADD COLUMN scored_at TEXT`);
  if (!columnExists("leads", "opted_out"))
    safeExec(`ALTER TABLE leads ADD COLUMN opted_out INTEGER DEFAULT 0`);
  // Кэш русского перевода сообщения (для просмотра истории на «На проверке»)
  if (!columnExists("messages", "content_ru"))
    safeExec(`ALTER TABLE messages ADD COLUMN content_ru TEXT`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC)`,
  );
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_messages_dlg_dir_time ON messages(dialogue_id, direction, created_at)`,
  );
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_leads_locked ON leads(locked_until)`,
  );

  // Daily-cap counters table
  safeExec(`CREATE TABLE IF NOT EXISTS daily_counters (
    date TEXT PRIMARY KEY,
    sent_email INTEGER DEFAULT 0,
    sent_tg INTEGER DEFAULT 0,
    ai_input_tokens INTEGER DEFAULT 0,
    ai_output_tokens INTEGER DEFAULT 0,
    ai_cache_read INTEGER DEFAULT 0,
    ai_cache_creation INTEGER DEFAULT 0
  )`);

  // Key-value settings
  safeExec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )`);
  if (!columnExists("settings", "updated_at")) {
    safeExec(`ALTER TABLE settings ADD COLUMN updated_at TEXT`);
  }

  // Pending replies queue
  safeExec(`CREATE TABLE IF NOT EXISTS pending_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    dialogue_id INTEGER,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    context TEXT,
    status TEXT DEFAULT 'pending',
    edited_body TEXT,
    edited_subject TEXT,
    admin_notes TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    sent_at TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id)
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_pending_replies_status ON pending_replies(status, created_at)`,
  );

  // Knowledge base (RAG)
  safeExec(`CREATE TABLE IF NOT EXISTS knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT,
    mime TEXT,
    size_bytes INTEGER,
    content TEXT,
    checksum TEXT,
    chunks_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  safeExec(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    token_count INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_kn_chunks_doc ON knowledge_chunks(doc_id)`,
  );
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_kn_docs_project ON knowledge_docs(project_id)`,
  );

  // lead_emails: fast exact-match
  safeExec(`CREATE TABLE IF NOT EXISTS lead_emails (
    lead_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    PRIMARY KEY (lead_id, email),
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_lead_emails_email ON lead_emails(email)`,
  );

  // Population: fill lead_emails from leads.email if empty
  try {
    const cnt = db.prepare("SELECT COUNT(*) AS n FROM lead_emails").get();
    if (cnt && cnt.n === 0) {
      const rows = db
        .prepare(
          `SELECT id, email FROM leads WHERE email IS NOT NULL AND email != ''`,
        )
        .all();
      if (rows.length > 0) {
        const ins = db.prepare(
          "INSERT OR IGNORE INTO lead_emails (lead_id, email) VALUES (?, ?)",
        );
        const tx = db.transaction(() => {
          for (const r of rows) {
            const emails = String(r.email)
              .split(/[;,]/)
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean);
            for (const e of emails) ins.run(r.id, e);
          }
        });
        tx();
        console.log(
          `[migrate][ws:${workspaceId}] populated lead_emails from ${rows.length} leads`,
        );
      }
    }
  } catch (e) {
    console.error(
      `[migrate][ws:${workspaceId}] lead_emails populate failed:`,
      e.message,
    );
  }

  // Email open tracking columns on messages
  if (!columnExists("messages", "opened_at"))
    safeExec(`ALTER TABLE messages ADD COLUMN opened_at TEXT`);
  if (!columnExists("messages", "open_count"))
    safeExec(`ALTER TABLE messages ADD COLUMN open_count INTEGER DEFAULT 0`);
  if (!columnExists("messages", "open_ip"))
    safeExec(`ALTER TABLE messages ADD COLUMN open_ip TEXT`);
  if (!columnExists("messages", "open_ua"))
    safeExec(`ALTER TABLE messages ADD COLUMN open_ua TEXT`);
  if (!columnExists("messages", "tracking_id"))
    safeExec(`ALTER TABLE messages ADD COLUMN tracking_id TEXT`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_messages_tracking_id ON messages(tracking_id)`,
  );

  // messages.resend_id
  if (!columnExists("messages", "resend_id")) {
    safeExec(`ALTER TABLE messages ADD COLUMN resend_id TEXT`);
  }
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_messages_resend_id ON messages(resend_id)`,
  );
  try {
    db.exec(`UPDATE messages SET resend_id = json_extract(metadata, '$.resend_id')
             WHERE metadata LIKE '%resend_id%' AND resend_id IS NULL`);
  } catch (e) {
    console.error(
      `[migrate][ws:${workspaceId}] resend_id backfill failed:`,
      e.message,
    );
  }
  safeExec(`CREATE TRIGGER IF NOT EXISTS trg_messages_resend_id AFTER INSERT ON messages
  FOR EACH ROW WHEN NEW.metadata LIKE '%resend_id%'
  BEGIN
    UPDATE messages SET resend_id = json_extract(NEW.metadata, '$.resend_id') WHERE id = NEW.id AND resend_id IS NULL;
  END`);

  // Dry-run log
  safeExec(`CREATE TABLE IF NOT EXISTS dry_run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    lead_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    would_send_to TEXT NOT NULL
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_dry_run_log_lead ON dry_run_log(lead_id)`,
  );

  // Dev tasks tracker
  safeExec(`CREATE TABLE IF NOT EXISTS dev_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  safeExec(`CREATE TABLE IF NOT EXISTS dev_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id INTEGER NOT NULL,
    parent_task_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'med',
    due_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(stage_id) REFERENCES dev_stages(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_task_id) REFERENCES dev_tasks(id) ON DELETE CASCADE
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_dev_tasks_stage ON dev_tasks(stage_id)`,
  );
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_dev_tasks_parent ON dev_tasks(parent_task_id)`,
  );

  // ─── Channel tags (catalog + per-channel assignment) ──────────────
  safeExec(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',
    created_at TEXT NOT NULL
  )`);
  safeExec(`CREATE TABLE IF NOT EXISTS channel_tags (
    channel_id TEXT PRIMARY KEY,
    tag_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )`);
  safeExec(
    `CREATE INDEX IF NOT EXISTS idx_channel_tags_tag ON channel_tags(tag_id)`,
  );

  // ─── Prepared Statements ──────────────────────────────────────────
  const stmts = buildStmts(db);

  const result = { db, stmts };
  databases.set(workspaceId, result);
  console.log(`[db] opened workspace database: ws-${workspaceId}.db`);
  return result;
}

// ─── Build prepared statements for a given db instance ─────────────
function buildStmts(db) {
  return {
    // Leads
    insertLead: db.prepare(`
      INSERT OR IGNORE INTO leads (
        channel_id, channel_name, channel_url, thumbnail, country,
        subscribers, avg_views, engagement_rate,
        email, telegram, whatsapp, raw_contacts, keyword,
        lead_status, dialogue_stage, created_at, updated_at
      ) VALUES (
        @channel_id, @channel_name, @channel_url, @thumbnail, @country,
        @subscribers, @avg_views, @engagement_rate,
        @email, @telegram, @whatsapp, @raw_contacts, @keyword,
        'pending', 'not_contacted', @created_at, @updated_at
      )
    `),
    listLeads: db.prepare(`
      SELECT * FROM leads
      WHERE (@status IS NULL OR lead_status = @status)
        AND (@stage IS NULL OR dialogue_stage = @stage)
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    countLeads: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN lead_status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN lead_status='ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN lead_status='in_work' THEN 1 ELSE 0 END) AS in_work,
        SUM(CASE WHEN lead_status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN lead_status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM leads
    `),
    getLead: db.prepare(`SELECT * FROM leads WHERE id = ?`),
    updateLeadStatus: db.prepare(`
      UPDATE leads SET lead_status = ?, updated_at = ? WHERE id = ?
    `),
    updateLeadNotes: db.prepare(`
      UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?
    `),
    bulkUpdateLeadStatus: db.prepare(`
      UPDATE leads SET lead_status = ?, updated_at = ? WHERE id = ?
    `),
    updateLeadSummary: db.prepare(
      `UPDATE leads SET content_summary = ?, updated_at = ? WHERE id = ?`,
    ),
    updateLeadSummaryDeep: db.prepare(
      `UPDATE leads SET content_summary = ?, is_deep_summary = 1, updated_at = ? WHERE id = ?`,
    ),
    listLeadsWithoutSummary: db.prepare(
      `SELECT id, channel_name, keyword, country, subscribers, avg_views, engagement_rate, channel_url, last_videos_json, channel_about_text, channel_tags, top_playlists_json, channel_age_days, channel_language, main_category, er_normalized, er_flags FROM leads WHERE content_summary IS NULL OR content_summary = '' LIMIT ?`,
    ),
    updateLeadEnrichment: db.prepare(`
      UPDATE leads SET
        last_videos_json = COALESCE(@last_videos_json, last_videos_json),
        channel_about_text = COALESCE(@channel_about_text, channel_about_text),
        channel_tags = COALESCE(@channel_tags, channel_tags),
        top_playlists_json = COALESCE(@top_playlists_json, top_playlists_json),
        channel_age_days = COALESCE(@channel_age_days, channel_age_days),
        channel_language = COALESCE(@channel_language, channel_language),
        main_category = COALESCE(@main_category, main_category),
        er_normalized = COALESCE(@er_normalized, er_normalized),
        er_flags = COALESCE(@er_flags, er_flags),
        enriched_at = @enriched_at,
        updated_at = @enriched_at
      WHERE id = @id
    `),
    listLeadsForEnrichment: db.prepare(`
      SELECT id, channel_id FROM leads
      WHERE enriched_at IS NULL OR enriched_at < ?
      LIMIT ?
    `),

    // Projects
    insertProject: db.prepare(`
      INSERT INTO projects (
        name, description, unique_selling_points, target_audience,
        budget_min, budget_max, ad_formats, language, is_active,
        ideal_channel_profile, bad_fit_examples, proof_points, value_prop_short,
        signature, cta_text, cta_link, creator_economics, tone_of_voice, stop_words,
        agent_persona,
        created_at, updated_at
      ) VALUES (
        @name, @description, @unique_selling_points, @target_audience,
        @budget_min, @budget_max, @ad_formats, @language, @is_active,
        @ideal_channel_profile, @bad_fit_examples, @proof_points, @value_prop_short,
        @signature, @cta_text, @cta_link, @creator_economics, @tone_of_voice, @stop_words,
        @agent_persona,
        @created_at, @updated_at
      )
    `),
    listProjects: db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`),
    getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    getActiveProject: db.prepare(
      `SELECT * FROM projects WHERE is_active = 1 LIMIT 1`,
    ),
    deactivateAllProjects: db.prepare(`UPDATE projects SET is_active = 0`),
    activateProject: db.prepare(
      `UPDATE projects SET is_active = 1, updated_at = ? WHERE id = ?`,
    ),
    updateProject: db.prepare(`
      UPDATE projects SET
        name = @name, description = @description,
        unique_selling_points = @unique_selling_points,
        target_audience = @target_audience,
        budget_min = @budget_min, budget_max = @budget_max,
        ad_formats = @ad_formats, language = @language,
        ideal_channel_profile = @ideal_channel_profile,
        bad_fit_examples = @bad_fit_examples,
        proof_points = @proof_points,
        value_prop_short = @value_prop_short,
        signature = @signature,
        cta_text = @cta_text,
        cta_link = @cta_link,
        creator_economics = @creator_economics,
        tone_of_voice = @tone_of_voice,
        stop_words = @stop_words,
        agent_persona = @agent_persona,
        admin_directive = @admin_directive,
        system_prompt = @system_prompt,
        reply_delay_min = @reply_delay_min,
        reply_delay_max = @reply_delay_max,
        updated_at = @updated_at
      WHERE id = @id
    `),
    deleteProject: db.prepare(`DELETE FROM projects WHERE id = ?`),

    // Dialogues
    insertDialogue: db.prepare(`
      INSERT INTO dialogues (lead_id, channel, external_thread_id, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getDialogue: db.prepare(`SELECT * FROM dialogues WHERE id = ?`),
    getDialogueByLead: db.prepare(
      `SELECT * FROM dialogues WHERE lead_id = ? AND channel = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    getDialogueByThread: db.prepare(
      `SELECT * FROM dialogues WHERE external_thread_id = ?`,
    ),
    listDialoguesByLead: db.prepare(
      `SELECT * FROM dialogues WHERE lead_id = ? ORDER BY created_at DESC`,
    ),
    updateDialogueThread: db.prepare(
      `UPDATE dialogues SET external_thread_id = ? WHERE id = ?`,
    ),
    listAllDialogues: db.prepare(`
      SELECT d.*, l.channel_name, l.country, l.subscribers, l.lead_status, l.dialogue_stage, l.notes,
             (SELECT content FROM messages WHERE dialogue_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM messages WHERE dialogue_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
             (SELECT COUNT(*) FROM messages WHERE dialogue_id = d.id) AS message_count,
             (SELECT opened_at FROM messages WHERE dialogue_id = d.id AND direction = 'out' ORDER BY created_at DESC LIMIT 1) AS last_out_opened_at,
             (SELECT open_count FROM messages WHERE dialogue_id = d.id AND direction = 'out' ORDER BY created_at DESC LIMIT 1) AS last_out_open_count
      FROM dialogues d
      JOIN leads l ON l.id = d.lead_id
      ORDER BY last_message_at DESC NULLS LAST, d.created_at DESC
    `),

    // Messages
    insertMessage: db.prepare(`
      INSERT INTO messages (dialogue_id, direction, sender, content, metadata, created_at, tracking_id)
      VALUES (@dialogue_id, @direction, @sender, @content, @metadata, @created_at, @tracking_id)
    `),
    listMessagesByDialogue: db.prepare(
      `SELECT * FROM messages WHERE dialogue_id = ? ORDER BY created_at ASC`,
    ),
    // Email open tracking: get last outgoing message open status per lead
    getLastOutgoingMessageOpen: db.prepare(`
      SELECT m.opened_at, m.open_count
      FROM messages m
      JOIN dialogues d ON d.id = m.dialogue_id
      WHERE d.lead_id = ? AND m.direction = 'out'
      ORDER BY m.created_at DESC
      LIMIT 1
    `),

    // Update lead dialogue stage
    updateLeadStage: db.prepare(
      `UPDATE leads SET dialogue_stage = ?, updated_at = ? WHERE id = ?`,
    ),
    updateLeadProject: db.prepare(
      `UPDATE leads SET project_id = ?, updated_at = ? WHERE id = ?`,
    ),
    updateLeadContacts: db.prepare(
      `UPDATE leads SET email = @email, telegram = @telegram, updated_at = @updated_at WHERE id = @id`,
    ),

    // Pick next ready lead for outreach
    pickNextLeadForOutreach: db.prepare(`
      SELECT * FROM leads
      WHERE lead_status = 'ready' AND dialogue_stage = 'not_contacted'
        AND (email != '' OR telegram != '')
        AND (locked_until IS NULL OR locked_until < @now)
        AND (opted_out IS NULL OR opted_out = 0)
      ORDER BY created_at ASC
      LIMIT 1
    `),

    // Lock/unlock lead
    lockLead: db.prepare(`UPDATE leads SET locked_until = ? WHERE id = ?`),
    unlockLead: db.prepare(`UPDATE leads SET locked_until = NULL WHERE id = ?`),

    // Daily counters
    getDailyCounters: db.prepare(`SELECT * FROM daily_counters WHERE date = ?`),
    upsertDailyCounters: db.prepare(`
      INSERT INTO daily_counters (date, sent_email, sent_tg, ai_input_tokens, ai_output_tokens, ai_cache_read, ai_cache_creation)
      VALUES (@date, @sent_email, @sent_tg, @ai_input_tokens, @ai_output_tokens, @ai_cache_read, @ai_cache_creation)
      ON CONFLICT(date) DO UPDATE SET
        sent_email = sent_email + excluded.sent_email,
        sent_tg = sent_tg + excluded.sent_tg,
        ai_input_tokens = ai_input_tokens + excluded.ai_input_tokens,
        ai_output_tokens = ai_output_tokens + excluded.ai_output_tokens,
        ai_cache_read = ai_cache_read + excluded.ai_cache_read,
        ai_cache_creation = ai_cache_creation + excluded.ai_cache_creation
    `),

    // Dialogue message count
    incrementDialogueMsgCount: db.prepare(
      `UPDATE dialogues SET message_count = COALESCE(message_count, 0) + 1 WHERE id = ?`,
    ),
    updateDialogueStage: db.prepare(
      `UPDATE dialogues SET external_thread_id = COALESCE(?, external_thread_id) WHERE id = ?`,
    ),

    // Pick leads with new replies
    pickLeadsWithNewReplies: db.prepare(`
      SELECT DISTINCT l.* FROM leads l
      JOIN dialogues d ON d.lead_id = l.id
      JOIN messages m ON m.dialogue_id = d.id
      WHERE l.lead_status IN ('ready','in_work')
        AND l.dialogue_stage NOT IN ('won','lost','deal_pending','moved_to_tg')
        AND m.direction = 'in'
        AND m.created_at > COALESCE(
          (SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'out'),
          '1970-01-01'
        )
        AND NOT EXISTS (
          SELECT 1 FROM pending_replies pr
          WHERE pr.lead_id = l.id
            AND pr.status = 'rejected'
            AND pr.created_at > COALESCE(
              (SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'in'),
              '1970-01-01'
            )
        )
    `),

    // Settings
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setSetting: db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    listSettings: db.prepare(`SELECT * FROM settings`),

    // Deals
    insertDeal: db.prepare(`
      INSERT INTO deals (lead_id, project_id, proposed_price, agent_summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    listPendingDeals: db.prepare(`
      SELECT d.*, l.channel_name, l.subscribers, l.country
      FROM deals d JOIN leads l ON l.id = d.lead_id
      WHERE d.admin_decision IS NULL
      ORDER BY d.created_at DESC
    `),
    decideDeal: db.prepare(
      `UPDATE deals SET admin_decision = ?, admin_notes = ?, decided_at = ? WHERE id = ?`,
    ),

    // Settings (key-value) — upsertSetting overrides getSetting above
    upsertSetting: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),

    // Pending replies (review-mode queue)
    insertPendingReply: db.prepare(`
      INSERT INTO pending_replies (lead_id, dialogue_id, channel, recipient, subject, body, context, status, created_at)
      VALUES (@lead_id, @dialogue_id, @channel, @recipient, @subject, @body, @context, 'pending', @created_at)
    `),
    getPendingReply: db.prepare(`SELECT * FROM pending_replies WHERE id = ?`),
    listPendingReplies: db.prepare(`
      SELECT pr.*, l.channel_name, l.country, l.subscribers
      FROM pending_replies pr
      LEFT JOIN leads l ON l.id = pr.lead_id
      WHERE (@status IS NULL OR pr.status = @status)
      ORDER BY pr.created_at DESC
      LIMIT @limit OFFSET @offset
    `),
    countPendingReplies: db.prepare(
      `SELECT COUNT(*) AS n FROM pending_replies WHERE status = ?`,
    ),
    approvePendingReply: db.prepare(`
      UPDATE pending_replies SET status = 'approved', edited_body = ?, edited_subject = ?, admin_notes = ?, decided_at = ? WHERE id = ?
    `),
    rejectPendingReply: db.prepare(`
      UPDATE pending_replies SET status = 'rejected', admin_notes = ?, decided_at = ? WHERE id = ?
    `),
    markPendingReplySent: db.prepare(
      `UPDATE pending_replies SET status = 'sent', sent_at = ? WHERE id = ?`,
    ),
    markPendingReplyFailed: db.prepare(
      `UPDATE pending_replies SET status = 'failed', admin_notes = ? WHERE id = ?`,
    ),
    pickApprovedPendingReplies: db.prepare(`
      SELECT pr.*, l.email AS lead_email, l.telegram AS lead_telegram, l.channel_name
      FROM pending_replies pr
      LEFT JOIN leads l ON l.id = pr.lead_id
      WHERE pr.status = 'approved'
      ORDER BY pr.decided_at ASC
      LIMIT ?
    `),

    // Follow-up candidates
    pickFollowUpCandidates: db.prepare(`
      SELECT l.*, d.id AS dlg_id, d.channel AS dlg_channel,
             (SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'out') AS last_out_at,
             (SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'in') AS last_in_at
      FROM leads l
      JOIN dialogues d ON d.lead_id = l.id
      WHERE l.lead_status = 'in_work'
        AND l.dialogue_stage IN ('contacted', 'negotiating', 'awaiting_reply', 'followup_1')
        AND COALESCE(l.followup_attempts, 0) < @max_attempts
        AND NOT EXISTS (
          SELECT 1 FROM pending_replies pr
          WHERE pr.lead_id = l.id AND pr.status IN ('pending', 'approved')
        )
        AND (SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'out') < @cutoff
        AND COALESCE((SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'in'), '1970-01-01')
            <= COALESCE((SELECT MAX(created_at) FROM messages WHERE dialogue_id = d.id AND direction = 'out'), '1970-01-01')
        AND (l.last_followup_at IS NULL OR l.last_followup_at < @cutoff)
      ORDER BY d.created_at ASC
      LIMIT @limit
    `),

    // lead_emails: fast exact-match
    findLeadByEmailExact: db.prepare(`
      SELECT l.* FROM lead_emails le JOIN leads l ON l.id = le.lead_id WHERE le.email = ? LIMIT 1
    `),
    insertLeadEmail: db.prepare(
      `INSERT OR IGNORE INTO lead_emails (lead_id, email) VALUES (?, ?)`,
    ),
    deleteLeadEmails: db.prepare(`DELETE FROM lead_emails WHERE lead_id = ?`),
    incrementLeadFollowUp: db.prepare(`
      UPDATE leads SET followup_attempts = COALESCE(followup_attempts,0) + 1, last_followup_at = ?, updated_at = ? WHERE id = ?
    `),

    // Knowledge
    insertKnowledgeDoc: db.prepare(`
      INSERT INTO knowledge_docs (project_id, kind, title, source, mime, size_bytes, content, checksum, status, created_at, updated_at)
      VALUES (@project_id, @kind, @title, @source, @mime, @size_bytes, @content, @checksum, @status, @created_at, @updated_at)
    `),
    getKnowledgeDoc: db.prepare(`SELECT * FROM knowledge_docs WHERE id = ?`),
    listKnowledgeDocs: db.prepare(`
      SELECT id, project_id, kind, title, source, mime, size_bytes, chunks_count, status, error, created_at, updated_at
      FROM knowledge_docs
      WHERE (@project_id IS NULL OR project_id = @project_id OR project_id IS NULL)
      ORDER BY created_at DESC
    `),
    updateKnowledgeDoc: db.prepare(`
      UPDATE knowledge_docs SET
        title = COALESCE(@title, title),
        content = COALESCE(@content, content),
        checksum = COALESCE(@checksum, checksum),
        size_bytes = COALESCE(@size_bytes, size_bytes),
        chunks_count = COALESCE(@chunks_count, chunks_count),
        status = COALESCE(@status, status),
        error = @error,
        updated_at = @updated_at
      WHERE id = @id
    `),
    setKnowledgeDocStatus: db.prepare(
      `UPDATE knowledge_docs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
    ),
    setKnowledgeDocChunks: db.prepare(
      `UPDATE knowledge_docs SET chunks_count = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?`,
    ),
    deleteKnowledgeDoc: db.prepare(`DELETE FROM knowledge_docs WHERE id = ?`),
    insertKnowledgeChunk: db.prepare(`
      INSERT INTO knowledge_chunks (doc_id, position, chunk_text, embedding, token_count, created_at)
      VALUES (@doc_id, @position, @chunk_text, @embedding, @token_count, @created_at)
    `),
    deleteChunksByDoc: db.prepare(
      `DELETE FROM knowledge_chunks WHERE doc_id = ?`,
    ),
    getAllChunksForProject: db.prepare(`
      SELECT c.id, c.doc_id, c.position, c.chunk_text, c.embedding,
             d.title AS doc_title, d.source AS doc_source, d.kind AS doc_kind
      FROM knowledge_chunks c
      JOIN knowledge_docs d ON d.id = c.doc_id
      WHERE (@project_id IS NULL OR d.project_id = @project_id OR d.project_id IS NULL)
        AND d.status = 'indexed'
    `),
    knowledgeStats: db.prepare(`
      SELECT
        COUNT(*) AS docs,
        SUM(CASE WHEN status='indexed' THEN 1 ELSE 0 END) AS indexed,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='indexing' THEN 1 ELSE 0 END) AS indexing,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        COALESCE(SUM(chunks_count),0) AS chunks
      FROM knowledge_docs
      WHERE (@project_id IS NULL OR project_id = @project_id OR project_id IS NULL)
    `),
  };
}

// Helper: sync lead_emails when lead email changes (workspace-scoped)
function syncLeadEmails(workspaceId, leadId, emailField) {
  // Backward compat: if called with 2 args (leadId, emailField), use default workspace
  if (arguments.length === 2) {
    emailField = leadId;
    leadId = workspaceId;
    workspaceId = "default";
  }
  const { db } = getDb(workspaceId);
  db.prepare("DELETE FROM lead_emails WHERE lead_id = ?").run(leadId);
  if (!emailField) return;
  const emails = String(emailField)
    .split(/[;,]/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO lead_emails (lead_id, email) VALUES (?, ?)",
  );
  for (const e of emails) ins.run(leadId, e);
}

// ─── Backward-compatible exports ───────────────────────────────────
// Lazy-init default workspace so existing code that does
//   const { db, stmts } = require('./database')
// continues to work without changes.
const _default = getDb("default");

module.exports = {
  getDb,
  syncLeadEmails,
  // Backward compat — point to default workspace
  db: _default.db,
  stmts: _default.stmts,
};
