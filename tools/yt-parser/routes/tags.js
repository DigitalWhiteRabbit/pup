const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");

const router = express.Router();

// Мутации защищены admin-токеном, GET — открыты (как на других роутерах).
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// Per-request workspace db.
router.use((req, res, next) => {
  req.db = getDb(req.workspaceId).db;
  next();
});

function sanitizeName(v) {
  return String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 40);
}
const TAG_PALETTE = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];
function isValidColor(v) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(v || "").trim());
}
function sanitizeColor(v) {
  const s = String(v || "").trim();
  return isValidColor(s) ? s : "#3b82f6";
}

// GET /api/tags → { tags: [...], assignments: { channelId: tagId } }
router.get("/", (req, res) => {
  try {
    const tags = req.db
      .prepare("SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE")
      .all();
    const rows = req.db
      .prepare("SELECT channel_id, tag_id FROM channel_tags")
      .all();
    const assignments = {};
    for (const r of rows) assignments[r.channel_id] = r.tag_id;
    res.json({ success: true, tags, assignments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tags { name, color? } → создать тег
router.post("/", (req, res) => {
  try {
    const name = sanitizeName(req.body.name);
    if (!name)
      return res.status(400).json({ success: false, error: "name обязателен" });
    // Цвет: явно переданный валидный — берём его; иначе следующий из палитры по кругу.
    let color;
    if (isValidColor(req.body.color)) {
      color = String(req.body.color).trim();
    } else {
      const cnt = req.db.prepare("SELECT COUNT(*) AS n FROM tags").get().n;
      color = TAG_PALETTE[cnt % TAG_PALETTE.length];
    }
    const info = req.db
      .prepare("INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)")
      .run(name, color, new Date().toISOString());
    const tag = req.db
      .prepare("SELECT id, name, color FROM tags WHERE id = ?")
      .get(info.lastInsertRowid);
    res.json({ success: true, tag });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/tags/:id { name?, color? } → переименовать / сменить цвет
router.patch("/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = req.db
      .prepare("SELECT id, name, color FROM tags WHERE id = ?")
      .get(id);
    if (!existing)
      return res.status(404).json({ success: false, error: "тег не найден" });
    const name =
      req.body.name !== undefined ? sanitizeName(req.body.name) : existing.name;
    if (!name)
      return res.status(400).json({ success: false, error: "name обязателен" });
    const color =
      req.body.color !== undefined
        ? sanitizeColor(req.body.color)
        : existing.color;
    req.db
      .prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?")
      .run(name, color, id);
    res.json({ success: true, tag: { id, name, color } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/tags/:id → удалить тег (FK ON DELETE CASCADE снимет привязки)
router.delete("/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    req.db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/tags/assign { channel_id, tag_id|null } → назначить / снять тег
router.put("/assign", (req, res) => {
  try {
    const channelId = String(req.body.channel_id || "").trim();
    if (!channelId)
      return res
        .status(400)
        .json({ success: false, error: "channel_id обязателен" });
    const rawTag = req.body.tag_id;
    if (rawTag === null || rawTag === undefined || rawTag === "") {
      req.db
        .prepare("DELETE FROM channel_tags WHERE channel_id = ?")
        .run(channelId);
      return res.json({ success: true, channel_id: channelId, tag_id: null });
    }
    const tagId = parseInt(rawTag, 10);
    const tag = req.db.prepare("SELECT id FROM tags WHERE id = ?").get(tagId);
    if (!tag)
      return res.status(404).json({ success: false, error: "тег не найден" });
    req.db
      .prepare(
        `INSERT INTO channel_tags (channel_id, tag_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET tag_id = excluded.tag_id, updated_at = excluded.updated_at`,
      )
      .run(channelId, tagId, new Date().toISOString());
    res.json({ success: true, channel_id: channelId, tag_id: tagId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
