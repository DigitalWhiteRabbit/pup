const express = require("express");
const router = express.Router();
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});
const { getDb } = require("../db/database");
const { verifyUnsubscribeToken } = require("../services/unsubscribe");

router.get("/", (req, res) => {
  const { token, id } = req.query;
  if (!token || !id) {
    return res.status(400).send("Неверная ссылка для отписки.");
  }
  const leadId = parseInt(id, 10);
  if (!leadId || isNaN(leadId)) {
    return res.status(400).send("Неверный идентификатор.");
  }
  if (!verifyUnsubscribeToken(token, leadId)) {
    return res.status(400).send("Неверная или устаревшая ссылка.");
  }
  try {
    const result = req.db
      .prepare("UPDATE leads SET opted_out = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), leadId);
    if (result.changes === 0) {
      return res.status(404).send("Контакт не найден.");
    }
    console.log(`[unsubscribe] lead #${leadId} opted out`);
  } catch (e) {
    console.error("[unsubscribe] DB error:", e.message);
    return res
      .status(500)
      .send("Ошибка сервера. Напишите нам напрямую для удаления из базы.");
  }

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Отписка</title>
<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333}
h2{color:#111}p{color:#555;line-height:1.6}</style>
</head><body>
<h2>Вы отписаны</h2>
<p>Ваш адрес удалён из рассылки.<br>Больше писем от нас не будет.</p>
</body></html>`);
});

module.exports = router;
