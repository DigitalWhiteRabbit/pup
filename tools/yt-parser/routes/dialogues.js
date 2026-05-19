const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");
const router = express.Router();
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

const MAX_ADMIN_MESSAGE_LEN = 10000;

// GET /api/dialogues  — список всех диалогов с превью
router.get("/", (req, res) => {
  const dialogues = req.stmts.listAllDialogues.all();
  res.json({ success: true, dialogues });
});

// GET /api/dialogues/:id/messages
router.get("/:id/messages", (req, res) => {
  const dialogue = req.stmts.getDialogue.get(req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });
  const messages = req.stmts.listMessagesByDialogue.all(req.params.id);
  const lead = req.stmts.getLead.get(dialogue.lead_id);
  res.json({ success: true, dialogue, lead, messages });
});

// POST /api/dialogues/:id/admin-message  — админ шлёт сообщение от своего имени
// (только сохраняет в БД, реальной отправки пока нет — это руками)
router.post("/:id/admin-message", adminAuth, (req, res) => {
  const { content } = req.body;
  if (!content)
    return res.status(400).json({ success: false, error: "content required" });
  if (typeof content !== "string" || content.length > MAX_ADMIN_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      error: `content must be string <= ${MAX_ADMIN_MESSAGE_LEN} chars`,
    });
  }

  const dialogue = req.stmts.getDialogue.get(req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });

  const now = new Date().toISOString();
  req.stmts.insertMessage.run({
    dialogue_id: dialogue.id,
    direction: "out",
    sender: "admin",
    content,
    metadata: JSON.stringify({ manual: true }),
    created_at: now,
  });
  res.json({ success: true });
});

module.exports = router;
