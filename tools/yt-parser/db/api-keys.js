/**
 * Global API key pool (shared across all workspaces).
 * Stores keys, per-day usage, and workspace assignments.
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "api-keys.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL UNIQUE,
    daily_quota INTEGER NOT NULL DEFAULT 10000,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_key_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    FOREIGN KEY(key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    UNIQUE(key_id, workspace_id)
  );

  CREATE TABLE IF NOT EXISTS api_key_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    units_used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    UNIQUE(key_id, date)
  );
`);

// ─── Helpers ────────────────────────────────────────────────────────

function today() {
  // YouTube quota resets at midnight Pacific Time
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
  )
    .toISOString()
    .slice(0, 10);
}

// ─── CRUD ───────────────────────────────────────────────────────────

function listKeys() {
  const keys = db
    .prepare(
      `SELECT k.*, COALESCE(u.units_used, 0) as used_today
     FROM api_keys k
     LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.date = ?
     ORDER BY k.id`,
    )
    .all(today());

  // Attach workspace assignments
  const assignments = db
    .prepare(`SELECT key_id, workspace_id FROM api_key_assignments`)
    .all();
  const assignMap = {};
  for (const a of assignments) {
    if (!assignMap[a.key_id]) assignMap[a.key_id] = [];
    assignMap[a.key_id].push(a.workspace_id);
  }
  return keys.map((k) => ({
    ...k,
    workspaces: assignMap[k.id] || [],
  }));
}

function addKey(apiKey, label = "", dailyQuota = 10000) {
  return db
    .prepare(
      `INSERT INTO api_keys (api_key, label, daily_quota) VALUES (?, ?, ?)`,
    )
    .run(apiKey, label, dailyQuota);
}

function removeKey(id) {
  return db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
}

function toggleKey(id, isActive) {
  return db
    .prepare(`UPDATE api_keys SET is_active = ? WHERE id = ?`)
    .run(isActive ? 1 : 0, id);
}

function assignKeyToWorkspace(keyId, workspaceId) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO api_key_assignments (key_id, workspace_id) VALUES (?, ?)`,
    )
    .run(keyId, workspaceId);
}

function unassignKeyFromWorkspace(keyId, workspaceId) {
  return db
    .prepare(
      `DELETE FROM api_key_assignments WHERE key_id = ? AND workspace_id = ?`,
    )
    .run(keyId, workspaceId);
}

// ─── Quota tracking ─────────────────────────────────────────────────

function getUsageToday(keyId) {
  const row = db
    .prepare(
      `SELECT units_used FROM api_key_usage WHERE key_id = ? AND date = ?`,
    )
    .get(keyId, today());
  return row ? row.units_used : 0;
}

function addUsage(keyId, units) {
  db.prepare(
    `INSERT INTO api_key_usage (key_id, date, units_used)
     VALUES (?, ?, ?)
     ON CONFLICT(key_id, date) DO UPDATE SET units_used = units_used + ?`,
  ).run(keyId, today(), units, units);
}

// ─── Key selection for workspace ────────────────────────────────────

/**
 * Get the best available API key for a workspace.
 * Returns the key with the most remaining quota.
 * If no workspace-specific keys, falls back to unassigned active keys.
 */
function getBestKeyForWorkspace(workspaceId) {
  const d = today();

  // First try workspace-assigned keys
  let key = db
    .prepare(
      `SELECT k.id, k.api_key, k.daily_quota, COALESCE(u.units_used, 0) as used_today
     FROM api_keys k
     JOIN api_key_assignments a ON a.key_id = k.id AND a.workspace_id = ?
     LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.date = ?
     WHERE k.is_active = 1
       AND COALESCE(u.units_used, 0) < k.daily_quota
     ORDER BY COALESCE(u.units_used, 0) ASC
     LIMIT 1`,
    )
    .get(workspaceId, d);

  if (key) return key;

  // Fallback: any active key not assigned to any workspace (shared pool)
  key = db
    .prepare(
      `SELECT k.id, k.api_key, k.daily_quota, COALESCE(u.units_used, 0) as used_today
     FROM api_keys k
     LEFT JOIN api_key_assignments a ON a.key_id = k.id
     LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.date = ?
     WHERE k.is_active = 1
       AND a.id IS NULL
       AND COALESCE(u.units_used, 0) < k.daily_quota
     ORDER BY COALESCE(u.units_used, 0) ASC
     LIMIT 1`,
    )
    .get(d);

  return key || null;
}

/**
 * Get ALL available keys for a workspace (for multi-key rotation in parser).
 */
function getKeysForWorkspace(workspaceId) {
  const d = today();

  const assigned = db
    .prepare(
      `SELECT k.id, k.api_key, k.label, k.daily_quota, COALESCE(u.units_used, 0) as used_today
     FROM api_keys k
     JOIN api_key_assignments a ON a.key_id = k.id AND a.workspace_id = ?
     LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.date = ?
     WHERE k.is_active = 1
     ORDER BY COALESCE(u.units_used, 0) ASC`,
    )
    .all(workspaceId, d);

  if (assigned.length > 0) return assigned;

  // Fallback to unassigned keys
  return db
    .prepare(
      `SELECT k.id, k.api_key, k.label, k.daily_quota, COALESCE(u.units_used, 0) as used_today
     FROM api_keys k
     LEFT JOIN api_key_assignments a ON a.key_id = k.id
     LEFT JOIN api_key_usage u ON u.key_id = k.id AND u.date = ?
     WHERE k.is_active = 1 AND a.id IS NULL
     ORDER BY COALESCE(u.units_used, 0) ASC`,
    )
    .all(d);
}

/**
 * Get total quota stats for a workspace.
 */
function getWorkspaceQuota(workspaceId) {
  const keys = getKeysForWorkspace(workspaceId);
  const totalQuota = keys.reduce((s, k) => s + k.daily_quota, 0);
  const totalUsed = keys.reduce((s, k) => s + k.used_today, 0);
  return {
    keys: keys.length,
    totalQuota,
    totalUsed,
    remaining: Math.max(0, totalQuota - totalUsed),
    perKey: keys.map((k) => ({
      id: k.id,
      label: k.label,
      quota: k.daily_quota,
      used: k.used_today,
      remaining: Math.max(0, k.daily_quota - k.used_today),
    })),
  };
}

module.exports = {
  listKeys,
  addKey,
  removeKey,
  toggleKey,
  assignKeyToWorkspace,
  unassignKeyFromWorkspace,
  getUsageToday,
  addUsage,
  getBestKeyForWorkspace,
  getKeysForWorkspace,
  getWorkspaceQuota,
};
