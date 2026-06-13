const express = require("express");
// Шаг 3.3b: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");
const router = express.Router();

router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const rows = await store.listConsultations(
    req.wsId,
    req.query.status || null,
  );
  res.json({ success: true, consultations: rows });
});

router.post("/:id/answer", adminAuth, async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const { admin_response } = req.body;
  if (!admin_response)
    return res
      .status(400)
      .json({ success: false, error: "admin_response required" });
  const now = new Date().toISOString();
  await store.answerConsultation(req.wsId, admin_response, now, id);
  res.json({ success: true });
});

module.exports = router;
