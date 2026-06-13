const express = require("express");
// Шаг 3.3b: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");
const router = express.Router();

// GET /api/deals?status=pending|approved|rejected
router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const status = req.query.status;
  let rows;
  if (status === "pending") {
    rows = await store.listPendingDeals(req.wsId);
  } else if (status) {
    rows = await store.listDealsByDecision(req.wsId, status);
  } else {
    rows = await store.listDealsByDecision(req.wsId, null);
  }
  res.json({ success: true, deals: rows });
});

// POST /api/deals/:id/approve  { notes? }
router.post("/:id/approve", adminAuth, async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const now = new Date().toISOString();
  await store.decideDeal(req.wsId, "approved", req.body.notes || null, now, id);
  res.json({ success: true });
});

router.post("/:id/reject", adminAuth, async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const now = new Date().toISOString();
  await store.decideDeal(req.wsId, "rejected", req.body.notes || null, now, id);
  res.json({ success: true });
});

module.exports = router;
