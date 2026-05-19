const express = require("express");
const router = express.Router();
const { adminAuth } = require("../utils/auth");
const apiKeys = require("../db/api-keys");

// List all keys (masked)
router.get("/", adminAuth, (req, res) => {
  const keys = apiKeys.listKeys();
  res.json({
    success: true,
    keys: keys.map((k) => ({
      ...k,
      api_key: k.api_key.slice(0, 8) + "..." + k.api_key.slice(-4),
      api_key_full: undefined,
    })),
  });
});

// Add key
router.post("/", adminAuth, (req, res) => {
  const { apiKey, label, dailyQuota } = req.body;
  if (!apiKey)
    return res.status(400).json({ success: false, error: "apiKey required" });
  try {
    const result = apiKeys.addKey(apiKey, label || "", dailyQuota || 10000);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res
        .status(409)
        .json({ success: false, error: "Key already exists" });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete key
router.delete("/:id", adminAuth, (req, res) => {
  apiKeys.removeKey(req.params.id);
  res.json({ success: true });
});

// Toggle active
router.patch("/:id/toggle", adminAuth, (req, res) => {
  apiKeys.toggleKey(req.params.id, req.body.isActive);
  res.json({ success: true });
});

// Assign to workspace
router.post("/:id/assign", adminAuth, (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId)
    return res
      .status(400)
      .json({ success: false, error: "workspaceId required" });
  apiKeys.assignKeyToWorkspace(req.params.id, workspaceId);
  res.json({ success: true });
});

// Unassign from workspace
router.post("/:id/unassign", adminAuth, (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId)
    return res
      .status(400)
      .json({ success: false, error: "workspaceId required" });
  apiKeys.unassignKeyFromWorkspace(req.params.id, workspaceId);
  res.json({ success: true });
});

// Workspace quota summary
router.get("/quota/:workspaceId", (req, res) => {
  const quota = apiKeys.getWorkspaceQuota(req.params.workspaceId);
  res.json({ success: true, ...quota });
});

module.exports = router;
