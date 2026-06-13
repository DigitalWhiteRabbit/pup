const express = require("express");
// Шаг 3.3b-5: публичный эндпоинт отписки переведён на db/prisma-store.
// Воркспейса в ссылке нет — лид резолвится по глобально-уникальному cuid (id),
// а подлинность подтверждается HMAC-токеном (services/unsubscribe, чистая крипта).
const store = require("../db/prisma-store");
const { verifyUnsubscribeToken } = require("../services/unsubscribe");

const router = express.Router();

// Страница успешной отписки (отдаём и при «уже отписан/не найден», чтобы не
// раскрывать существование адреса и не пугать получателя ошибкой).
const DONE_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Отписка</title>
<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333}
h2{color:#111}p{color:#555;line-height:1.6}</style>
</head><body>
<h2>Вы отписаны</h2>
<p>Ваш адрес удалён из рассылки.<br>Больше писем от нас не будет.</p>
</body></html>`;

router.get("/", async (req, res) => {
  const { token, id } = req.query;
  // id — cuid-строка (раньше был int). Никакого parseInt.
  const leadId = typeof id === "string" ? id.trim() : "";
  if (!token || !leadId) {
    return res.status(400).send("Неверная ссылка для отписки.");
  }
  if (!verifyUnsubscribeToken(token, leadId)) {
    return res.status(400).send("Неверная или устаревшая ссылка.");
  }
  try {
    const result = await store.optOutLeadById(leadId);
    if (result.changes > 0) {
      console.log(`[unsubscribe] lead ${leadId} opted out`);
    }
    // Даже если лид не найден (changes === 0) — показываем страницу отписки,
    // ссылка подписана корректным токеном, повторный клик не должен падать.
  } catch (e) {
    // Никаких 500 на публичном эндпоинте — токен валиден, отвечаем безопасно.
    console.error("[unsubscribe] DB error:", e.message);
  }

  res.send(DONE_PAGE);
});

module.exports = router;
