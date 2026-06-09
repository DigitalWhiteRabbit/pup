const express = require("express");
const tg = require("../services/telegram-outreach");
const { adminAuth } = require("../utils/auth");
const router = express.Router();

// Все TG-мутации требуют admin token. (GET-статусы — открыты.)
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// ─── Legacy single-account API (текущий UI до Фазы 2) ───────────────

router.get("/status", (req, res) => {
  res.json({ success: true, ...tg.status() });
});

router.post("/login", async (req, res) => {
  try {
    const result = await tg.startLogin();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post("/code", (req, res) => {
  try {
    const { code } = req.body;
    if (!code)
      return res.status(400).json({ success: false, error: "code required" });
    tg.provideCode(String(code));
    res.json({ success: true, ...tg.status() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post("/password", (req, res) => {
  try {
    const { password } = req.body;
    if (!password)
      return res
        .status(400)
        .json({ success: false, error: "password required" });
    tg.providePassword(String(password));
    res.json({ success: true, ...tg.status() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post("/logout", async (req, res) => {
  await tg.logout();
  res.json({ success: true });
});

// ─── Multi-account pool API (Фаза 1) ────────────────────────────────

// GET /api/telegram/accounts — список аккаунтов со статусом (без секретов)
router.get("/accounts", (req, res) => {
  res.json({ success: true, accounts: tg.listAccounts() });
});

// GET /api/telegram/accounts/:id
router.get("/accounts/:id", (req, res) => {
  const s = tg.accountStatus(parseInt(req.params.id, 10));
  if (!s) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, account: s });
});

// POST /api/telegram/accounts — создать аккаунт
// { label?, phone?, api_id?, api_hash?, proxy_type?, proxy_host?, proxy_port?,
//   proxy_user?, proxy_pass?, proxy_string?, daily_cap? }
router.post("/accounts", (req, res) => {
  try {
    let fields = { ...req.body };
    if (fields.proxy_string) {
      Object.assign(fields, tg.parseProxyString(fields.proxy_string));
      delete fields.proxy_string;
    }
    const account = tg.createAccount(fields);
    res.json({ success: true, account: tg.accountStatus(account.id) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// PATCH /api/telegram/accounts/:id — обновить поля (прокси/лимит/статус/label)
router.patch("/accounts/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    tg.updateAccount(id, req.body || {});
    res.json({ success: true, account: tg.accountStatus(id) });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// DELETE /api/telegram/accounts/:id
router.delete("/accounts/:id", async (req, res) => {
  try {
    await tg.deleteAccount(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// POST /api/telegram/accounts/:id/login
router.post("/accounts/:id/login", async (req, res) => {
  try {
    const result = await tg.loginAccount(parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// POST /api/telegram/accounts/:id/code { code }
router.post("/accounts/:id/code", (req, res) => {
  try {
    const { code } = req.body;
    if (!code)
      return res.status(400).json({ success: false, error: "code required" });
    tg.provideCodeFor(parseInt(req.params.id, 10), String(code));
    res.json({
      success: true,
      account: tg.accountStatus(parseInt(req.params.id, 10)),
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// POST /api/telegram/accounts/:id/password { password }
router.post("/accounts/:id/password", (req, res) => {
  try {
    const { password } = req.body;
    if (!password)
      return res
        .status(400)
        .json({ success: false, error: "password required" });
    tg.providePasswordFor(parseInt(req.params.id, 10), String(password));
    res.json({
      success: true,
      account: tg.accountStatus(parseInt(req.params.id, 10)),
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// POST /api/telegram/accounts/:id/qa-ready — QA-ТОЛЬКО (при DRY_RUN): пометить
// аккаунт «готовым» в пуле БЕЗ реального коннекта (для визуального QA статусов).
router.post("/accounts/:id/qa-ready", (req, res) => {
  const dry = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  if (!dry)
    return res
      .status(403)
      .json({ success: false, error: "qa-ready доступен только при DRY_RUN" });
  if (typeof tg.__testInjectReady !== "function")
    return res.status(404).json({ success: false, error: "not available" });
  const id = parseInt(req.params.id, 10);
  tg.__testInjectReady(id, req.body?.ready !== false);
  res.json({ success: true, account: tg.accountStatus(id) });
});

// POST /api/telegram/accounts/:id/logout
router.post("/accounts/:id/logout", async (req, res) => {
  try {
    await tg.logoutAccount(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

module.exports = router;
