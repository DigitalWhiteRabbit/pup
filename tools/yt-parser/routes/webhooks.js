// Публичные вебхуки внешних сервисов (без adminAuth). Защита — проверка подписи.
// Смонтирован с express.raw ДО глобального express.json, чтобы иметь сырое тело
// для верификации Svix-подписи Resend.
const express = require("express");
const crypto = require("crypto");
const store = require("../db/prisma-store");

const router = express.Router();

// Проверка Svix-подписи (Resend). Заголовки: svix-id, svix-timestamp, svix-signature.
// secret вида "whsec_<base64>". Подписывается `${id}.${ts}.${rawBody}` через HMAC-SHA256.
function verifySvix(rawBody, headers, secret) {
  if (!secret) return false;
  const id = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!id || !ts || !sigHeader) return false;

  // Защита от replay: отвергаем метки старше 5 минут.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return false;
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = `${id}.${ts}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", key)
    .update(signed)
    .digest("base64");
  const expBuf = Buffer.from(expected);

  // Заголовок может содержать несколько подписей: "v1,sig1 v1,sig2"
  return sigHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean)
    .some((sig) => {
      const sigBuf = Buffer.from(sig);
      return (
        sigBuf.length === expBuf.length &&
        crypto.timingSafeEqual(sigBuf, expBuf)
      );
    });
}

// POST /api/webhooks/resend — события доставки писем.
// req.body — Buffer (express.raw), верифицируем сырое тело, затем парсим.
let _warnedNoSecret = false;
router.post("/resend", async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret && !_warnedNoSecret) {
    _warnedNoSecret = true;
    console.warn(
      "[resend-webhook] RESEND_WEBHOOK_SECRET не задан — все вебхуки отклоняются (401), доставка не трекается",
    );
  }
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body || "");

  if (!verifySvix(raw, req.headers, secret)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let evt;
  try {
    evt = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "bad json" });
  }

  const svixId = String(req.headers["svix-id"] || "");
  const data = evt && evt.data ? evt.data : {};
  const resendId = data.email_id || data.id || null;
  const occurredAt =
    evt.created_at || data.created_at || new Date().toISOString();

  try {
    await store.recordEmailEvent({
      svixId,
      resendId,
      type: evt.type,
      occurredAt,
      payload: JSON.stringify(evt).slice(0, 4000),
    });
    // 200 всегда при успешной обработке (включая дубли), чтобы Resend не ретраил.
    return res.json({ ok: true });
  } catch (e) {
    console.error("[resend-webhook]", e.message);
    // 500 → Resend повторит доставку позже.
    return res.status(500).json({ error: "processing error" });
  }
});

module.exports = router;
