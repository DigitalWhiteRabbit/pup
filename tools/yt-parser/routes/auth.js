const express = require("express");
const crypto = require("crypto");
const {
  setSessionCookie,
  clearSessionCookie,
  getSession,
} = require("../utils/session");

const router = express.Router();

// Простая защита от брутфорса (in-memory, per-process)
const attempts = new Map(); // ip → { count, lockUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;

function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

function safeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

router.post("/login", (req, res) => {
  const ip = clientIp(req);
  const state = attempts.get(ip) || { count: 0, lockUntil: 0 };
  if (state.lockUntil && Date.now() < state.lockUntil) {
    const waitSec = Math.ceil((state.lockUntil - Date.now()) / 1000);
    return res
      .status(429)
      .json({
        success: false,
        error: `слишком много попыток, подожди ${waitSec}с`,
      });
  }

  const { login, code } = req.body || {};
  const expectedLogin = process.env.AUTH_LOGIN;
  const expectedCode = process.env.AUTH_CODE;

  if (!expectedLogin || !expectedCode) {
    return res
      .status(500)
      .json({
        success: false,
        error: "AUTH_LOGIN/AUTH_CODE не заданы на сервере",
      });
  }

  if (
    !login ||
    !code ||
    !safeEq(String(login), expectedLogin) ||
    !safeEq(String(code), expectedCode)
  ) {
    state.count++;
    if (state.count >= MAX_ATTEMPTS) {
      state.lockUntil = Date.now() + LOCK_MS;
      state.count = 0;
    }
    attempts.set(ip, state);
    return res
      .status(401)
      .json({ success: false, error: "неверный логин или код" });
  }

  attempts.delete(ip);
  setSessionCookie(res, { login: expectedLogin });
  res.json({ success: true, login: expectedLogin });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get("/me", (req, res) => {
  const sess = getSession(req);
  if (!sess)
    return res.status(401).json({ success: false, authenticated: false });
  res.json({ success: true, authenticated: true, login: sess.login });
});

module.exports = router;
