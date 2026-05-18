/**
 * Сессии через httpOnly cookie (HMAC-подпись, без внешних зависимостей).
 *
 * ENV:
 *   AUTH_LOGIN       — логин пользователя (например "bruno")
 *   AUTH_CODE        — 6-значный код доступа
 *   SESSION_SECRET   — секрет для HMAC (если не задан, генерируется на старте)
 *   SESSION_TTL_DAYS — время жизни сессии в днях (default: 14)
 */

const crypto = require("crypto");

const COOKIE_NAME = "bruno_sess";
const TTL_MS =
  (parseInt(process.env.SESSION_TTL_DAYS, 10) || 14) * 24 * 3600 * 1000;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[session] SESSION_SECRET не задан — сгенерирован временный (сессии сбросятся при рестарте)",
  );
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = b64url(
    crypto.createHmac("sha256", SECRET).update(body).digest(),
  );
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
    return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, payload) {
  const exp = Date.now() + TTL_MS;
  const token = sign({ ...payload, iat: Date.now(), exp });
  const maxAge = Math.floor(TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies[COOKIE_NAME]);
}

// Разрешённые пути без сессии
const PUBLIC_PATHS = new Set([
  "/login.html",
  "/favicon.ico",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
]);

function isPublicPath(p) {
  if (PUBLIC_PATHS.has(p)) return true;
  // статика логин-страницы (css/js если появится)
  if (p.startsWith("/login-assets/")) return true;
  return false;
}

function authGate(req, res, next) {
  // Если AUTH_LOGIN не задан — auth выключена (dev-режим)
  if (!process.env.AUTH_LOGIN || !process.env.AUTH_CODE) return next();

  if (isPublicPath(req.path)) return next();

  // Программный доступ через ADMIN_TOKEN — пропускаем
  const adminToken =
    req.headers["x-admin-token"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (
    adminToken &&
    process.env.ADMIN_TOKEN &&
    adminToken === process.env.ADMIN_TOKEN
  ) {
    return next();
  }

  const sess = getSession(req);
  if (sess && sess.login) {
    req.session = sess;
    return next();
  }

  // API → 401 JSON, иначе редирект на логин
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  return res.redirect("/login.html");
}

module.exports = {
  sign,
  verify,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  authGate,
  COOKIE_NAME,
};
