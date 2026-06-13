const express = require("express");
// Шаг 3.3b-2: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
// Теги — MktTag, привязка — MktLead.tagId (один тег на лида, как channel_tags).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");

const router = express.Router();

// Мутации защищены admin-токеном, GET — открыты (как на других роутерах).
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
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
router.get("/", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const tags = await store.listTags(req.wsId);
    const rows = await store.listChannelTags(req.wsId);
    const assignments = {};
    for (const r of rows) assignments[r.channel_id] = r.tag_id;
    res.json({ success: true, tags, assignments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/tags { name, color? } → создать тег
router.post("/", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const name = sanitizeName(req.body.name);
    if (!name)
      return res.status(400).json({ success: false, error: "name обязателен" });
    // Цвет: явно переданный валидный — берём его; иначе следующий из палитры по кругу.
    let color;
    if (isValidColor(req.body.color)) {
      color = String(req.body.color).trim();
    } else {
      const cnt = await store.countTags(req.wsId);
      color = TAG_PALETTE[cnt % TAG_PALETTE.length];
    }
    const tag = await store.createTag(req.wsId, name, color);
    res.json({ success: true, tag });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/tags/:id { name?, color? } → переименовать / сменить цвет
router.patch("/:id", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const id = req.params.id; // cuid-строка
    const existing = await store.getTag(req.wsId, id);
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
    const tag = await store.updateTag(req.wsId, id, name, color);
    res.json({ success: true, tag });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/tags/:id → удалить тег (relation SetNull снимет привязки у лидов)
router.delete("/:id", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    await store.deleteTag(req.wsId, req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/tags/assign { channel_id, tag_id|null } → назначить / снять тег
router.put("/assign", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const channelId = String(req.body.channel_id || "").trim();
    if (!channelId)
      return res
        .status(400)
        .json({ success: false, error: "channel_id обязателен" });
    const rawTag = req.body.tag_id;
    if (rawTag === null || rawTag === undefined || rawTag === "") {
      await store.removeChannelTag(req.wsId, channelId);
      return res.json({ success: true, channel_id: channelId, tag_id: null });
    }
    const tagId = String(rawTag); // cuid-строка
    const tag = await store.getTag(req.wsId, tagId);
    if (!tag)
      return res.status(404).json({ success: false, error: "тег не найден" });
    await store.setChannelTag(req.wsId, channelId, tagId);
    res.json({ success: true, channel_id: channelId, tag_id: tagId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
