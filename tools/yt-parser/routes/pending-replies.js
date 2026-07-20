const express = require("express");
// Шаг 3.3b-4: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
// Worker-вызовы (processApprovedQueue/onPendingReplyRejected) — легаси до 3.3c.
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");
const worker = require("../services/outreach-worker");

const router = express.Router();

// Дефолтное окно случайной задержки одобренного письма (минуты). Перекрывается
// настройками кампании reply_delay_min/max.
const DEFAULT_DELAY_MIN = 1;
const DEFAULT_DELAY_MAX = 10;

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// GET /api/pending-replies?status=pending&limit=100&offset=0
router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const status = req.query.status || "pending";
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = await store.listPendingReplies(req.wsId, {
    status: status === "all" ? null : status,
    limit,
    offset,
  });

  // Enrich sent items with email open tracking data
  for (const row of rows) {
    if (row.status === "sent" && row.channel === "email") {
      try {
        // Find the message created from this pending_reply (metadata contains pending_reply_id)
        const msg = await store.findMessageOpenByPendingReplyId(
          req.wsId,
          row.id,
        );
        row.msg_opened_at = msg?.opened_at || null;
        row.msg_open_count = msg?.open_count || 0;
      } catch {
        row.msg_opened_at = null;
        row.msg_open_count = 0;
      }
    } else {
      row.msg_opened_at = null;
      row.msg_open_count = 0;
    }
  }

  const counts = {
    pending: (await store.countPendingReplies(req.wsId, "pending"))?.n || 0,
    approved: (await store.countPendingReplies(req.wsId, "approved"))?.n || 0,
    rejected: (await store.countPendingReplies(req.wsId, "rejected"))?.n || 0,
    sent: (await store.countPendingReplies(req.wsId, "sent"))?.n || 0,
    failed: (await store.countPendingReplies(req.wsId, "failed"))?.n || 0,
  };
  res.json({ success: true, items: rows, counts });
});

// GET /api/pending-replies/count
router.get("/count", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const pending =
    (await store.countPendingReplies(req.wsId, "pending"))?.n || 0;
  res.json({ success: true, pending });
});

// GET /api/pending-replies/:id
router.get("/:id", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const row = await store.getPendingReply(req.wsId, req.params.id);
  if (!row) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, item: row });
});

// POST /api/pending-replies/:id/approve { edited_body?, edited_subject?, admin_notes? }
router.post("/:id/approve", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const item = await store.getPendingReply(req.wsId, id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const editedBody =
    (req.body.edited_body || "").toString().slice(0, 20000) || null;
  const editedSubject =
    (req.body.edited_subject || "").toString().slice(0, 500) || null;
  const notes = (req.body.admin_notes || "").toString().slice(0, 1000) || null;
  const now = new Date().toISOString();
  await store.approvePendingReply(
    req.wsId,
    editedBody,
    editedSubject,
    notes,
    now,
    id,
  );

  // Одобренное письмо не уходит сразу: у каждого свой случайный таймер из
  // настроек кампании (reply_delay_min/max, по умолчанию 1-10 минут). Раньше
  // первый питч (type=initial) шёл в обход очереди — теперь очередь общая для
  // всех, иначе пачка одобрений уходит залпом с одного домена.
  const project = await store.getActiveProject(req.wsId);
  const delayMin = Math.max(0, project?.reply_delay_min ?? DEFAULT_DELAY_MIN);
  const delayMax = Math.max(
    delayMin,
    project?.reply_delay_max ?? DEFAULT_DELAY_MAX,
  );

  if (delayMax > 0) {
    const delayMs =
      (delayMin + Math.random() * (delayMax - delayMin)) * 60 * 1000;
    const sendAfter = new Date(Date.now() + delayMs).toISOString();
    await store.setPendingReplySendAfter(req.wsId, sendAfter, id);
    res.json({
      success: true,
      send_after: sendAfter,
      delay_minutes: Math.round(delayMs / 60000),
    });
  } else {
    // Задержка отключена в настройках (min=max=0) — отдаём воркеру сразу.
    const wsId = req.workspaceId;
    setImmediate(() => {
      worker
        .processApprovedQueue(wsId)
        .catch((err) => console.error("[approve] worker error:", err.message));
    });
    res.json({ success: true, send_after: null });
  }
});

// POST /api/pending-replies/:id/reject { admin_notes? }
router.post("/:id/reject", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const item = await store.getPendingReply(req.wsId, id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const notes = (req.body.admin_notes || "").toString().slice(0, 1000) || null;
  const now = new Date().toISOString();
  await store.rejectPendingReply(req.wsId, notes, now, id);

  // Отклонить = вывести лида из авто-очереди (иначе при запущенном агенте
  // ready+not_contacted сразу подхватывается и письмо генерируется заново —
  // бесконечная петля). Лид остаётся в «Лидах» со статусом rejected (↺ восстановить).
  if (item.lead_id) {
    await store.updateLeadStatus(req.wsId, "rejected", now, item.lead_id);
    await store.unlockLead(req.wsId, item.lead_id);
  }

  try {
    await worker.onPendingReplyRejected(req.wsId, id);
  } catch {}
  res.json({ success: true });
});

// POST /api/pending-replies/:id/move-to-tg
// Снять письмо с очереди и пометить лида «Перешли в ТГ». В отличие от reject —
// НЕ возвращает лида в рассылку (lead_status не сбрасывается), а ставит стадию
// moved_to_tg → AI-агент перестаёт писать этому лиду, лид остаётся в базе.
router.post("/:id/move-to-tg", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const item = await store.getPendingReply(req.wsId, id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const now = new Date().toISOString();
  // Снимаем письмо с очереди (rejected → уходит из «Ждут», воркер не сгенерит заново)
  await store.rejectPendingReply(
    req.wsId,
    "Перешли в ТГ (снято вручную)",
    now,
    id,
  );

  // Помечаем лида «Перешли в ТГ»; в рассылку НЕ возвращаем (lead_status не трогаем)
  if (item.lead_id) {
    await store.updateLeadStage(req.wsId, "moved_to_tg", now, item.lead_id);
    await store.unlockLead(req.wsId, item.lead_id);
  }

  try {
    await worker.onPendingReplyRejected(req.wsId, id);
  } catch {}
  res.json({ success: true });
});

// DELETE /api/pending-replies/:id — удалить запись из очереди (независимо от статуса)
router.delete("/:id", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  // Get lead_id before deleting so we can reset the lead
  const item = await store.getPendingReply(req.wsId, id);
  await store.deletePendingReply(req.wsId, id);

  // Reset lead so "Запустить" appears again
  if (item?.lead_id) {
    await store.resetLeadForRun(req.wsId, item.lead_id, true);
  }

  res.json({ success: true });
});

// POST /api/pending-replies/purge-old — удалить sent/rejected старше 7 дней
router.post("/purge-old", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await store.purgeOldPendingReplies(req.wsId, cutoff);
  res.json({ success: true, removed: r.changes });
});

// POST /api/pending-replies/:id/regenerate { field: "subject"|"body"|"both" }
router.post("/:id/regenerate", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const field = req.body.field || "both";
  const pr = await store.getPendingReply(req.wsId, id);
  if (!pr) return res.status(404).json({ success: false, error: "not found" });

  const lead = await store.getLead(req.wsId, pr.lead_id);
  const project = await store.getActiveProject(req.wsId);
  if (!lead || !project)
    return res
      .status(400)
      .json({ success: false, error: "lead or project not found" });

  try {
    const ai = require("../services/ai");
    const angle = `Это перегенерация — напиши полноценный первый питч. Канал одобрен админом.`;

    // Try up to 3 times
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await ai.generateInitialPitch(
        lead,
        project,
        pr.channel || "email",
        angle,
        req.wsId,
      );
      if (!r) continue;

      // For subject-only: we only need a good subject
      if (field === "subject") {
        if (r.subject && r.subject.length >= 5) {
          result = r;
          break;
        }
        continue;
      }

      // For body or both: validate body quality
      const body = r.body || "";
      const badBody =
        body.length < 50 ||
        !/\n/.test(body.trim()) ||
        /ожидаю|консультац|placeholder|решения команды|релевантност|уточнен|запрос.*админ/i.test(
          body,
        );
      if (!badBody) {
        result = r;
        break;
      }
    }

    if (!result) {
      return res.status(500).json({
        success: false,
        error: "AI не смог сгенерировать. Попробуйте ещё раз.",
      });
    }

    const response = { success: true };

    if (field === "subject") {
      const subj = result.subject || pr.subject;
      await store.updatePendingReplyContent(req.wsId, id, { subject: subj });
      response.subject = subj;
    } else if (field === "body") {
      await store.updatePendingReplyContent(req.wsId, id, {
        body: result.body,
      });
      response.body = result.body;
    } else {
      const subj = result.subject || pr.subject;
      await store.updatePendingReplyContent(req.wsId, id, {
        subject: subj,
        body: result.body,
      });
      response.subject = subj;
      response.body = result.body;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/pending-replies/:id/lead-context — full AI context for this lead
router.get("/:id/lead-context", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const pr = await store.getPendingReply(req.wsId, req.params.id);
  if (!pr) return res.status(404).json({ success: false, error: "not found" });

  const lead = await store.getLead(req.wsId, pr.lead_id);
  if (!lead)
    return res.status(404).json({ success: false, error: "lead not found" });

  // Parse content_summary
  let summary = {};
  try {
    summary = JSON.parse(lead.content_summary || "{}");
  } catch {}

  // Parse videos
  let videos = [];
  try {
    videos = JSON.parse(lead.last_videos_json || "[]");
  } catch {}

  // Parse contacts
  let contacts = {};
  try {
    contacts = JSON.parse(lead.raw_contacts || "{}");
  } catch {}

  res.json({
    success: true,
    context: {
      channel_name: lead.channel_name,
      channel_url: lead.channel_url,
      subscribers: lead.subscribers,
      avg_views: lead.avg_views,
      engagement_rate: lead.engagement_rate,
      country: lead.country,
      channel_language: lead.channel_language,
      main_category: lead.main_category,
      keyword: lead.keyword,
      channel_about: lead.channel_about_text,
      channel_tags: lead.channel_tags,
      channel_age_days: lead.channel_age_days,
      // Parsed summary
      niche: summary.niche,
      content_style: summary.content_style,
      audience: summary.audience,
      tone: summary.tone,
      recent_topics: summary.recent_topics || [],
      pitch_hooks: summary.pitch_hooks || [],
      red_flags: summary.red_flags || [],
      // Videos
      recent_videos: (videos || []).slice(0, 5).map((v) => ({
        title: v.title,
        views: v.views,
        published: v.publishedAt,
      })),
      // Contacts
      email: lead.email,
      telegram: lead.telegram,
      contacts,
      // Scores
      lead_score: lead.lead_score,
      score_breakdown: lead.score_breakdown,
    },
  });
});

// POST /api/pending-replies/:id/translate { subject, body }
router.post("/:id/translate", async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.json({ success: true, body_ru: "", subject_ru: "" });

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();
    const text = (subject ? `Subject: ${subject}\n\n` : "") + body;
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Переведи на русский язык. Верни ТОЛЬКО перевод, без пояснений. Если текст уже на русском — верни как есть.\n\n${text}`,
        },
      ],
    });
    const translated = r.content?.[0]?.text || "";
    // Split back subject and body if subject was included
    let subject_ru = "";
    let body_ru = translated;
    if (subject && translated.startsWith("Тема:")) {
      const parts = translated.split("\n\n");
      subject_ru = parts[0].replace(/^Тема:\s*/, "");
      body_ru = parts.slice(1).join("\n\n");
    } else if (subject && translated.includes("\n\n")) {
      const idx = translated.indexOf("\n\n");
      subject_ru = translated.slice(0, idx).replace(/^Subject:\s*/i, "");
      body_ru = translated.slice(idx + 2);
    }
    res.json({ success: true, subject_ru, body_ru });
  } catch (e) {
    res.json({
      success: true,
      subject_ru: "",
      body_ru: "(ошибка перевода: " + e.message + ")",
    });
  }
});

// GET /api/pending-replies/:id/history — полная история переписки с лидом
// (оригинал + перевод на русский; перевод кэшируется в messages.content_ru)
router.get("/:id/history", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const pr = await store.getPendingReply(req.wsId, req.params.id);
  if (!pr) return res.status(404).json({ success: false, error: "not found" });

  const lead = pr.lead_id ? await store.getLead(req.wsId, pr.lead_id) : null;

  // Находим диалог: из pending_reply.dialogue_id, иначе по lead_id
  let dialogueId = pr.dialogue_id;
  if (!dialogueId && pr.lead_id) {
    const d = await store.getAnyDialogueByLead(req.wsId, pr.lead_id);
    dialogueId = d?.id || null;
  }
  if (!dialogueId) {
    return res.json({
      success: true,
      channel_name: lead?.channel_name || pr.channel_name || "",
      messages: [],
    });
  }

  const messages = await store.listMessagesByDialogue(req.wsId, dialogueId);

  // Перевод недостающих сообщений (параллельно), с записью в кэш
  const toTranslate = messages.filter(
    (m) => m.content && m.content.trim() && !m.content_ru,
  );
  if (toTranslate.length) {
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic();
      await Promise.all(
        toTranslate.map(async (m) => {
          try {
            const r = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              messages: [
                {
                  role: "user",
                  content: `Переведи на русский язык. Верни ТОЛЬКО перевод, без пояснений. Если текст уже на русском — верни как есть.\n\n${m.content}`,
                },
              ],
            });
            const tr = r.content?.[0]?.text || "";
            m.content_ru = tr;
            await store.setMessageContentRu(req.wsId, m.id, tr);
          } catch (e) {
            m.content_ru = "(ошибка перевода)";
          }
        }),
      );
    } catch (e) {
      // Anthropic недоступен — отдадим без перевода
    }
  }

  const out = messages.map((m) => {
    let subject = "";
    try {
      subject = JSON.parse(m.metadata || "{}").subject || "";
    } catch {}
    return {
      id: m.id,
      direction: m.direction,
      sender: m.sender,
      content: m.content,
      content_ru: m.content_ru || "",
      subject,
      created_at: m.created_at,
    };
  });

  res.json({
    success: true,
    channel_name: lead?.channel_name || pr.channel_name || "",
    messages: out,
  });
});

// POST /api/pending-replies/:id/force-send — skip timer, send immediately
router.post("/:id/force-send", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const item = await store.getPendingReply(req.wsId, id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "approved")
    return res.status(400).json({ success: false, error: "not approved" });

  // Clear send_after to allow immediate processing
  await store.setPendingReplySendAfter(req.wsId, null, id);

  // Trigger processApprovedQueue (worker — легаси до 3.3c)
  const wsId = req.workspaceId;
  setImmediate(() => {
    worker
      .processApprovedQueue(wsId)
      .catch((err) => console.error("[force-send] error:", err.message));
  });

  res.json({ success: true });
});

// POST /api/pending-replies/:id/retry — повторная отправка письма со статусом failed
// { edited_body?, edited_subject? } — сохраняет правки из формы перед повтором
router.post("/:id/retry", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const item = await store.getPendingReply(req.wsId, id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "failed")
    return res.status(400).json({ success: false, error: "not failed" });

  // Сохраняем возможные правки текста/темы из формы
  const editedBody =
    req.body.edited_body !== undefined
      ? req.body.edited_body.toString().slice(0, 20000) || null
      : item.edited_body;
  const editedSubject =
    req.body.edited_subject !== undefined
      ? req.body.edited_subject.toString().slice(0, 500) || null
      : item.edited_subject;

  // Возвращаем в approved, чистим таймер и текст ошибки → уйдёт немедленно
  const now = new Date().toISOString();
  await store.retryPendingReply(req.wsId, id, editedBody, editedSubject, now);

  const wsId = req.workspaceId;
  setImmediate(() => {
    worker
      .processApprovedQueue(wsId)
      .catch((err) => console.error("[retry] error:", err.message));
  });

  res.json({ success: true });
});

module.exports = router;
