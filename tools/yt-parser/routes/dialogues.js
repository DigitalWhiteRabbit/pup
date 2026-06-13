const express = require("express");
// Шаг 3.3b: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");
const router = express.Router();

const MAX_ADMIN_MESSAGE_LEN = 10000;

// GET /api/dialogues  — список всех диалогов с превью
router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const dialogues = await store.listAllDialogues(req.wsId);
  res.json({ success: true, dialogues });
});

// GET /api/dialogues/:id/messages
router.get("/:id/messages", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const dialogue = await store.getDialogue(req.wsId, req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });
  // Показываем ВСЕ сообщения лида (по всем его диалогам), а не только этого
  // треда — иначе ответ блогера из старой ветки другой кампании не виден.
  const messages = await store.listMessagesByLead(req.wsId, dialogue.lead_id);
  const lead = await store.getLead(req.wsId, dialogue.lead_id);
  res.json({ success: true, dialogue, lead, messages });
});

// POST /api/dialogues/:id/admin-message  — админ шлёт сообщение от своего имени
// (только сохраняет в БД, реальной отправки пока нет — это руками)
router.post("/:id/admin-message", adminAuth, async (req, res) => {
  if (!requireWsId(req, res)) return;
  const { content } = req.body;
  if (!content)
    return res.status(400).json({ success: false, error: "content required" });
  if (typeof content !== "string" || content.length > MAX_ADMIN_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      error: `content must be string <= ${MAX_ADMIN_MESSAGE_LEN} chars`,
    });
  }

  const dialogue = await store.getDialogue(req.wsId, req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });

  const now = new Date().toISOString();
  await store.insertMessage(req.wsId, {
    dialogue_id: dialogue.id,
    direction: "out",
    sender: "admin",
    content,
    metadata: JSON.stringify({ manual: true }),
    created_at: now,
    tracking_id: null,
  });
  res.json({ success: true });
});

module.exports = router;
