const express = require("express");
const tg = require("../services/telegram-outreach");
const { adminAuth } = require("../utils/auth");
const router = express.Router();

// Все TG-мутации (login/code/password/logout) требуют admin token
router.use(["/login", "/code", "/password", "/logout"], adminAuth);

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
    // Wait briefly so frontend can re-poll status
    setTimeout(() => {}, 500);
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

module.exports = router;
