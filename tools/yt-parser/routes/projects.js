const express = require("express");
const { stmts, db } = require("../db/database");
const { generateInitialPitch } = require("../services/ai");

const router = express.Router();

const { adminAuth } = require("../utils/auth");
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// GET /api/projects
router.get("/", (req, res) => {
  const projects = stmts.listProjects.all();
  res.json({ success: true, projects });
});

// GET /api/projects/active
router.get("/active", (req, res) => {
  const project = stmts.getActiveProject.get();
  res.json({ success: true, project: project || null });
});

// GET /api/projects/:id
router.get("/:id", (req, res) => {
  const project = stmts.getProject.get(req.params.id);
  if (!project)
    return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, project });
});

// POST /api/projects
router.post("/", (req, res) => {
  const {
    name,
    description,
    unique_selling_points,
    target_audience,
    budget_min,
    budget_max,
    ad_formats,
    language,
    ideal_channel_profile,
    bad_fit_examples,
    proof_points,
    value_prop_short,
    signature,
    cta_text,
    cta_link,
    creator_economics,
    tone_of_voice,
    stop_words,
    agent_persona,
  } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: "name обязателен" });
  }
  // description в новом гибридном подходе может быть пустым — заменяется на agent_persona + knowledge.
  const effectiveDescription = description || agent_persona || name;

  const now = new Date().toISOString();
  const result = stmts.insertProject.run({
    name,
    description: effectiveDescription,
    unique_selling_points: unique_selling_points || null,
    target_audience: target_audience || null,
    budget_min: budget_min ? parseInt(budget_min, 10) : null,
    budget_max: budget_max ? parseInt(budget_max, 10) : null,
    ad_formats: ad_formats
      ? JSON.stringify(Array.isArray(ad_formats) ? ad_formats : [ad_formats])
      : null,
    language: language || "ru",
    is_active: 0,
    ideal_channel_profile: ideal_channel_profile || null,
    bad_fit_examples: bad_fit_examples || null,
    proof_points: proof_points || null,
    value_prop_short: value_prop_short || null,
    signature: signature || null,
    cta_text: cta_text || null,
    cta_link: cta_link || null,
    creator_economics: creator_economics || null,
    tone_of_voice: tone_of_voice || null,
    stop_words: stop_words || null,
    agent_persona: agent_persona || null,
    created_at: now,
    updated_at: now,
  });

  const project = stmts.getProject.get(result.lastInsertRowid);
  res.json({ success: true, project });
});

// PATCH /api/projects/:id
router.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = stmts.getProject.get(id);
  if (!existing)
    return res.status(404).json({ success: false, error: "not found" });

  const merged = {
    id,
    name: req.body.name ?? existing.name,
    description: req.body.description ?? existing.description,
    unique_selling_points:
      req.body.unique_selling_points ?? existing.unique_selling_points,
    target_audience: req.body.target_audience ?? existing.target_audience,
    budget_min:
      req.body.budget_min !== undefined
        ? parseInt(req.body.budget_min, 10)
        : existing.budget_min,
    budget_max:
      req.body.budget_max !== undefined
        ? parseInt(req.body.budget_max, 10)
        : existing.budget_max,
    ad_formats:
      req.body.ad_formats !== undefined
        ? JSON.stringify(
            Array.isArray(req.body.ad_formats)
              ? req.body.ad_formats
              : [req.body.ad_formats],
          )
        : existing.ad_formats,
    language: req.body.language ?? existing.language,
    ideal_channel_profile:
      req.body.ideal_channel_profile ?? existing.ideal_channel_profile,
    bad_fit_examples: req.body.bad_fit_examples ?? existing.bad_fit_examples,
    proof_points: req.body.proof_points ?? existing.proof_points,
    value_prop_short: req.body.value_prop_short ?? existing.value_prop_short,
    signature: req.body.signature ?? existing.signature,
    cta_text: req.body.cta_text ?? existing.cta_text,
    cta_link: req.body.cta_link ?? existing.cta_link,
    creator_economics: req.body.creator_economics ?? existing.creator_economics,
    tone_of_voice: req.body.tone_of_voice ?? existing.tone_of_voice,
    stop_words: req.body.stop_words ?? existing.stop_words,
    agent_persona: req.body.agent_persona ?? existing.agent_persona,
    updated_at: new Date().toISOString(),
  };

  stmts.updateProject.run(merged);
  res.json({ success: true, project: stmts.getProject.get(id) });
});

// POST /api/projects/:id/activate
router.post("/:id/activate", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tx = db.transaction(() => {
    stmts.deactivateAllProjects.run();
    stmts.activateProject.run(new Date().toISOString(), id);
  });
  tx();
  res.json({ success: true, project: stmts.getProject.get(id) });
});

// DELETE /api/projects/:id
router.delete("/:id", (req, res) => {
  stmts.deleteProject.run(req.params.id);
  res.json({ success: true });
});

// POST /api/projects/:id/test-pitch  { lead_id }
// Генерирует тестовый pitch БЕЗ отправки.
router.post("/:id/test-pitch", async (req, res) => {
  try {
    const project = stmts.getProject.get(req.params.id);
    if (!project)
      return res
        .status(404)
        .json({ success: false, error: "project not found" });

    const { lead_id, channel } = req.body;
    if (!lead_id)
      return res
        .status(400)
        .json({ success: false, error: "lead_id required" });

    const lead = stmts.getLead.get(lead_id);
    if (!lead)
      return res.status(404).json({ success: false, error: "lead not found" });

    const pitch = await generateInitialPitch(lead, project, channel || "email");
    res.json({
      success: true,
      pitch,
      lead: {
        id: lead.id,
        channel_name: lead.channel_name,
        country: lead.country,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
