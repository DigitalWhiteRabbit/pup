const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");

const router = express.Router();
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

const VALID_STATUS = ["todo", "in_progress", "done", "blocked"];
const VALID_PRIORITY = ["low", "med", "high"];

function now() {
  return new Date().toISOString();
}

function aggregateProgress(req, stageId) {
  const row = req.db
    .prepare(
      `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM dev_tasks WHERE stage_id = ?
  `,
    )
    .get(stageId);
  return {
    total: row.total || 0,
    done: row.done || 0,
    in_progress: row.in_progress || 0,
    blocked: row.blocked || 0,
    percent: row.total ? Math.round((row.done / row.total) * 100) : 0,
  };
}

// ─── Stages ─────────────────────────────────────────────────────────
router.get("/stages", (req, res) => {
  const includeArchived = req.query.archived === "1";
  const where = includeArchived ? "" : `WHERE status = 'active'`;
  const stages = req.db
    .prepare(`SELECT * FROM dev_stages ${where} ORDER BY position ASC, id ASC`)
    .all();
  const enriched = stages.map((s) => ({
    ...s,
    progress: aggregateProgress(req, s.id),
  }));
  res.json({ success: true, stages: enriched });
});

router.post("/stages", (req, res) => {
  const { name, description = null } = req.body || {};
  if (!name || !String(name).trim())
    return res.status(400).json({ success: false, error: "name required" });
  const t = now();
  const maxPos = req.db
    .prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM dev_stages`)
    .get().m;
  const r = req.db
    .prepare(
      `
    INSERT INTO dev_stages (name, description, position, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `,
    )
    .run(String(name).trim(), description, maxPos + 1, t, t);
  const stage = req.db
    .prepare("SELECT * FROM dev_stages WHERE id = ?")
    .get(r.lastInsertRowid);
  res.json({
    success: true,
    stage: { ...stage, progress: aggregateProgress(req, stage.id) },
  });
});

router.patch("/stages/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stage = req.db.prepare("SELECT * FROM dev_stages WHERE id = ?").get(id);
  if (!stage)
    return res.status(404).json({ success: false, error: "not found" });
  const { name, description, status, position } = req.body || {};
  if (status && !["active", "archived"].includes(status)) {
    return res.status(400).json({ success: false, error: "bad status" });
  }
  req.db
    .prepare(
      `UPDATE dev_stages SET
    name = COALESCE(?, name),
    description = COALESCE(?, description),
    status = COALESCE(?, status),
    position = COALESCE(?, position),
    updated_at = ?
    WHERE id = ?`,
    )
    .run(
      name ?? null,
      description ?? null,
      status ?? null,
      position ?? null,
      now(),
      id,
    );
  const updated = req.db
    .prepare("SELECT * FROM dev_stages WHERE id = ?")
    .get(id);
  res.json({
    success: true,
    stage: { ...updated, progress: aggregateProgress(req, id) },
  });
});

router.delete("/stages/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = req.db.prepare("DELETE FROM dev_stages WHERE id = ?").run(id);
  res.json({ success: true, deleted: r.changes });
});

// ─── Tasks ──────────────────────────────────────────────────────────
router.get("/stages/:id/tasks", (req, res) => {
  const stageId = parseInt(req.params.id, 10);
  const tasks = req.db
    .prepare(
      `
    SELECT * FROM dev_tasks WHERE stage_id = ?
    ORDER BY COALESCE(parent_task_id, 0) ASC, position ASC, id ASC
  `,
    )
    .all(stageId);
  // Вложенная структура
  const byId = new Map();
  const roots = [];
  for (const t of tasks) {
    t.subtasks = [];
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    if (t.parent_task_id) {
      const parent = byId.get(t.parent_task_id);
      if (parent) parent.subtasks.push(t);
      else roots.push(t);
    } else {
      roots.push(t);
    }
  }
  res.json({ success: true, tasks: roots });
});

router.post("/tasks", (req, res) => {
  const {
    stage_id,
    parent_task_id = null,
    title,
    description = null,
    status = "todo",
    priority = "med",
    due_date = null,
  } = req.body || {};
  if (!stage_id)
    return res.status(400).json({ success: false, error: "stage_id required" });
  if (!title || !String(title).trim())
    return res.status(400).json({ success: false, error: "title required" });
  if (!VALID_STATUS.includes(status))
    return res.status(400).json({ success: false, error: "bad status" });
  if (!VALID_PRIORITY.includes(priority))
    return res.status(400).json({ success: false, error: "bad priority" });

  const stage = req.db
    .prepare("SELECT id FROM dev_stages WHERE id = ?")
    .get(stage_id);
  if (!stage)
    return res.status(400).json({ success: false, error: "stage not found" });

  const t = now();
  const maxPos = req.db
    .prepare(
      `SELECT COALESCE(MAX(position), 0) AS m FROM dev_tasks WHERE stage_id = ? AND COALESCE(parent_task_id, 0) = ?`,
    )
    .get(stage_id, parent_task_id || 0).m;

  const r = req.db
    .prepare(
      `
    INSERT INTO dev_tasks (stage_id, parent_task_id, title, description, status, priority, due_date, position, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      stage_id,
      parent_task_id,
      String(title).trim(),
      description,
      status,
      priority,
      due_date,
      maxPos + 1,
      t,
      t,
      status === "done" ? t : null,
    );

  const task = req.db
    .prepare("SELECT * FROM dev_tasks WHERE id = ?")
    .get(r.lastInsertRowid);
  res.json({ success: true, task });
});

router.patch("/tasks/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = req.db.prepare("SELECT * FROM dev_tasks WHERE id = ?").get(id);
  if (!task)
    return res.status(404).json({ success: false, error: "not found" });
  const {
    title,
    description,
    status,
    priority,
    due_date,
    position,
    parent_task_id,
  } = req.body || {};
  if (status && !VALID_STATUS.includes(status))
    return res.status(400).json({ success: false, error: "bad status" });
  if (priority && !VALID_PRIORITY.includes(priority))
    return res.status(400).json({ success: false, error: "bad priority" });

  const completed_at =
    status === "done" && task.status !== "done"
      ? now()
      : status && status !== "done"
        ? null
        : task.completed_at;

  req.db
    .prepare(
      `UPDATE dev_tasks SET
    title = COALESCE(?, title),
    description = COALESCE(?, description),
    status = COALESCE(?, status),
    priority = COALESCE(?, priority),
    due_date = ?,
    position = COALESCE(?, position),
    parent_task_id = ?,
    completed_at = ?,
    updated_at = ?
    WHERE id = ?
  `,
    )
    .run(
      title ?? null,
      description ?? null,
      status ?? null,
      priority ?? null,
      due_date === undefined ? task.due_date : due_date,
      position ?? null,
      parent_task_id === undefined ? task.parent_task_id : parent_task_id,
      completed_at,
      now(),
      id,
    );
  res.json({
    success: true,
    task: req.db.prepare("SELECT * FROM dev_tasks WHERE id = ?").get(id),
  });
});

router.delete("/tasks/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = req.db.prepare("DELETE FROM dev_tasks WHERE id = ?").run(id);
  res.json({ success: true, deleted: r.changes });
});

module.exports = router;
