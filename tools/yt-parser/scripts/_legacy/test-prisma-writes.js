/**
 * test-prisma-writes.js — round-trip тест WRITE-слоя prisma-store (Шаг 3.2).
 *
 * Создаёт ВРЕМЕННЫЙ воркспейс, гоняет все write-функции с проверкой чтением
 * (read-слой Шага 3.1), в конце удаляет воркспейс (каскад чистит все Mkt*).
 * QA-воркспейс (cmqbkwccn0001onqtv7q6ihrd) НЕ затрагивается.
 *
 * Запуск: node db/test-prisma-writes.js  — ожидается exit=0
 */
require("dotenv").config();
const crypto = require("crypto");
const store = require("./prisma-store");

const { prisma } = store;
const QA_WS = "cmqbkwccn0001onqtv7q6ihrd";

let passed = 0;
let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function qaCounts() {
  const [leads, dialogues, messages, projects] = await Promise.all([
    prisma.mktLead.count({ where: { workspaceId: QA_WS } }),
    prisma.mktDialogue.count({ where: { lead: { workspaceId: QA_WS } } }),
    prisma.mktMessage.count({
      where: { dialogue: { lead: { workspaceId: QA_WS } } },
    }),
    prisma.mktProject.count({ where: { workspaceId: QA_WS } }),
  ]);
  return { leads, dialogues, messages, projects };
}

async function main() {
  const qaBefore = await qaCounts();

  // ─── Временный воркспейс ────────────────────────────────────────────────
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL || "admin@example.com";
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin)
    throw new Error(`Админ <${adminEmail}> не найден — нужен pnpm db:seed`);

  const rnd = crypto.randomBytes(4).toString("hex");
  const ws = await prisma.workspace.create({
    data: {
      name: `QA write-test ${rnd}`,
      slug: `qa-write-test-${rnd}`,
      description:
        "временный воркспейс write-теста prisma-store — удаляется в teardown",
      ownerId: admin.id,
    },
  });
  const W = ws.id;
  console.log(`\n━━━ Write-тест prisma-store (временный ws ${W}) ━━━\n`);

  try {
    const nowIso = new Date().toISOString();

    // ─── 1. upsert лида + чтение ──────────────────────────────────────────
    console.log("── leads");
    const leadParams = {
      channel_id: "WT_CH_1",
      channel_name: "Write-Test Channel",
      channel_url: "https://youtube.com/@wt",
      thumbnail: null,
      country: "DE",
      subscribers: 4242,
      avg_views: 999,
      engagement_rate: 3.14,
      email: "wt@example.com",
      telegram: "@wt_channel",
      whatsapp: null,
      raw_contacts: null,
      keyword: "write test",
      created_at: nowIso,
      updated_at: nowIso,
    };
    const ins1 = await store.insertLead(W, leadParams);
    assert("insertLead создал (changes=1)", ins1.changes === 1 && !!ins1.id);
    const leadId = ins1.id;

    let lead = await store.getLead(W, leadId);
    assert("чтение: channel_id", lead.channel_id === "WT_CH_1");
    assert("чтение: lead_status='pending'", lead.lead_status === "pending");
    assert(
      "чтение: dialogue_stage='not_contacted'",
      lead.dialogue_stage === "not_contacted",
    );
    assert("чтение: subscribers число", lead.subscribers === 4242);
    assert(
      "чтение: created_at ISO-строка",
      typeof lead.created_at === "string" &&
        !isNaN(Date.parse(lead.created_at)),
    );

    // идемпотентность upsert
    const ins2 = await store.insertLead(W, leadParams);
    assert(
      "повторный insertLead — ignore (changes=0, тот же id)",
      ins2.changes === 0 && ins2.id === leadId,
    );
    const cnt = await store.countLeads(W);
    assert(
      "лид не задублирован (total=1)",
      cnt.total === 1,
      `total=${cnt.total}`,
    );

    // статус/стадия (legacy → enum → legacy)
    await store.updateLeadStatus(W, "ready", nowIso, leadId);
    await store.updateLeadStage(W, "queued", nowIso, leadId);
    lead = await store.getLead(W, leadId);
    assert(
      "updateLeadStatus: ready→READY→'ready'",
      lead.lead_status === "ready",
    );
    assert(
      "updateLeadStage: queued→QUEUED→'queued'",
      lead.dialogue_stage === "queued",
    );

    // notes / contacts / summary / enrichment
    await store.updateLeadNotes(W, "заметка", nowIso, leadId);
    await store.updateLeadContacts(W, {
      id: leadId,
      email: "new@example.com",
      telegram: "@new_tg",
      updated_at: nowIso,
    });
    await store.updateLeadSummaryDeep(W, "глубокое summary", nowIso, leadId);
    await store.updateLeadEnrichment(W, {
      id: leadId,
      channel_language: "de",
      main_category: "tech",
      er_normalized: 2.5,
      enriched_at: nowIso,
      // остальные null → не должны затирать
      last_videos_json: null,
      channel_about_text: null,
      channel_tags: null,
      top_playlists_json: null,
      channel_age_days: null,
      er_flags: null,
    });
    lead = await store.getLead(W, leadId);
    assert("notes записаны", lead.notes === "заметка");
    assert("contacts: email обновлён", lead.email === "new@example.com");
    assert(
      "summary deep: контент + флаг 1",
      lead.content_summary === "глубокое summary" && lead.is_deep_summary === 1,
    );
    assert(
      "enrichment: language/category/er",
      lead.channel_language === "de" &&
        lead.main_category === "tech" &&
        lead.er_normalized === 2.5,
    );
    assert("enrichment: enriched_at ISO", typeof lead.enriched_at === "string");

    // lock / followup / opted_out
    const lockMs = Date.now() + 60000;
    await store.lockLead(W, lockMs, leadId);
    lead = await store.getLead(W, leadId);
    assert(
      "lockLead: locked_until ms-число",
      lead.locked_until === lockMs,
      `got ${lead.locked_until}`,
    );
    await store.unlockLead(W, leadId);
    lead = await store.getLead(W, leadId);
    assert("unlockLead: null", lead.locked_until === null);
    await store.incrementLeadFollowUp(W, nowIso, nowIso, leadId);
    await store.incrementLeadFollowUp(W, nowIso, nowIso, leadId);
    lead = await store.getLead(W, leadId);
    assert(
      "followup_attempts=2 после двух инкрементов",
      lead.followup_attempts === 2,
    );
    await store.markLeadOptedOut(W, nowIso, leadId);
    lead = await store.getLead(W, leadId);
    assert("opted_out=1", lead.opted_out === 1);

    // analysis_* → MktLeadAnalysis (upsert)
    await store.updateLeadAnalysis(W, leadId, {
      verdict: "good",
      recommendation: "контактировать",
      score: 87,
      reasoning: "тест",
      metrics: { er: 3.14 },
      analyzed_at: nowIso,
    });
    lead = await store.getLead(W, leadId);
    assert(
      "analysis: score/verdict плоско из связи",
      lead.analysis_score === 87 && lead.analysis_verdict === "good",
    );
    await store.updateLeadAnalysis(W, leadId, {
      verdict: "excellent",
      recommendation: "срочно",
      score: 95,
      reasoning: "повтор",
      metrics: null,
      analyzed_at: nowIso,
    });
    lead = await store.getLead(W, leadId);
    const analysisRows = await prisma.mktLeadAnalysis.count({
      where: { leadId },
    });
    assert(
      "analysis upsert: обновился, не задублировался",
      lead.analysis_score === 95 && analysisRows === 1,
    );

    // ─── 2. dialogue + message ────────────────────────────────────────────
    console.log("── dialogues & messages");
    const dIns = await store.insertDialogue(
      W,
      leadId,
      "email",
      "thread-wt-1",
      nowIso,
    );
    assert("insertDialogue создал", dIns.changes === 1 && !!dIns.id);
    const dialogueId = dIns.id;
    await store.setDialogueAccount(W, 42, dialogueId);
    const dlg = await store.getDialogue(W, dialogueId);
    assert("setDialogueAccount: 42 (число в legacy)", dlg.account_id === 42);

    const mIns = await store.insertMessage(W, {
      dialogue_id: dialogueId,
      direction: "out",
      sender: "agent",
      content: "Первое письмо",
      metadata: null,
      created_at: nowIso,
      tracking_id: "trk-wt-1",
    });
    assert("insertMessage создал", mIns.changes === 1);
    await store.insertMessage(W, {
      dialogue_id: dialogueId,
      direction: "in",
      sender: "blogger",
      content: "Ответ блогера",
      metadata: null,
      created_at: new Date(Date.now() + 1000).toISOString(),
      tracking_id: null,
    });
    const msgs = await store.listMessagesByLead(W, leadId);
    assert("2 сообщения по лиду", msgs.length === 2);
    assert(
      "enum round-trip: out→OUT→'out'",
      msgs[0].direction === "out" && msgs[0].sender === "agent",
    );
    assert(
      "enum round-trip: blogger→EXTERNAL→'blogger'",
      msgs[1].sender === "blogger",
    );

    // tracking open: первое открытие + инкремент
    await store.recordMessageOpen(W, nowIso, "1.2.3.4", "UA", "trk-wt-1");
    await store.recordMessageOpen(
      W,
      new Date(Date.now() + 5000).toISOString(),
      "1.2.3.4",
      "UA",
      "trk-wt-1",
    );
    const open = await store.getLastOutgoingMessageOpen(W, leadId);
    assert(
      "recordMessageOpen: open_count=2, opened_at от ПЕРВОГО открытия",
      open.open_count === 2 &&
        open.opened_at === new Date(nowIso).toISOString(),
      JSON.stringify(open),
    );

    // ─── 3. pending: create → send_after → approve → sent ─────────────────
    console.log("── pending replies");
    const prIns = await store.insertPendingReply(W, {
      lead_id: leadId,
      dialogue_id: dialogueId,
      channel: "email",
      recipient: "new@example.com",
      subject: "Тема",
      body: "Текст питча",
      context: JSON.stringify({ type: "initial" }),
      created_at: nowIso,
    });
    assert("insertPendingReply создал (status=pending)", prIns.changes === 1);
    const prId = prIns.id;
    let pr = await store.getPendingReply(W, prId);
    assert("чтение: status='pending'", pr.status === "pending");

    const sendAfterIso = new Date(Date.now() + 3600000).toISOString();
    await store.setPendingReplySendAfter(W, sendAfterIso, prId);
    pr = await store.getPendingReply(W, prId);
    assert("send_after записан ISO", pr.send_after === sendAfterIso);

    await store.approvePendingReply(
      W,
      "правленый текст",
      null,
      "ок",
      nowIso,
      prId,
    );
    pr = await store.getPendingReply(W, prId);
    assert(
      "approve: status='approved', edited_body",
      pr.status === "approved" && pr.edited_body === "правленый текст",
    );

    await store.markPendingReplySent(W, nowIso, prId);
    pr = await store.getPendingReply(W, prId);
    assert(
      "sent: status='sent', sent_at ISO",
      pr.status === "sent" && typeof pr.sent_at === "string",
    );

    const prCnt = await store.countPendingReplies(W, "sent");
    assert("countPendingReplies(sent).n=1", prCnt.n === 1);

    // ─── 4. project: create → activate (single-active) ────────────────────
    console.log("── projects");
    const p1 = await store.insertProject(W, {
      name: "WT Project A",
      description: "первый",
      language: "ru",
      is_active: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const p2 = await store.insertProject(W, {
      name: "WT Project B",
      description: "второй",
      language: "ru",
      is_active: 0,
      created_at: new Date(Date.now() + 1000).toISOString(),
      updated_at: nowIso,
    });
    assert("два проекта созданы", p1.changes === 1 && p2.changes === 1);

    await store.activateProject(W, nowIso, p2.id);
    const projects = await store.listProjects(W);
    const active = projects.filter((p) => p.is_active === 1);
    assert(
      "single-active: ровно один активный и это B",
      active.length === 1 && active[0].id === p2.id,
      `active=[${active.map((p) => p.name)}]`,
    );
    const viaGet = await store.getActiveProject(W);
    assert("getActiveProject → B", viaGet && viaGet.id === p2.id);

    await store.updateProject(W, {
      id: p2.id,
      name: "WT Project B v2",
      description: "обновлён",
      system_prompt: "ты агент",
      reply_delay_min: 10,
      reply_delay_max: 20,
      language: "ru",
    });
    const updated = await store.getProject(W, p2.id);
    assert(
      "updateProject: name/system_prompt/delays",
      updated.name === "WT Project B v2" &&
        updated.system_prompt === "ты агент" &&
        updated.reply_delay_min === 10,
    );

    // привязка лида к проекту
    await store.updateLeadProject(W, p2.id, nowIso, leadId);
    lead = await store.getLead(W, leadId);
    assert("updateLeadProject: project_id=cuid", lead.project_id === p2.id);

    // ─── 5. deal: create → approve ────────────────────────────────────────
    console.log("── deals");
    const dealIns = await store.insertDeal(
      W,
      leadId,
      p2.id,
      50000,
      "сводка сделки",
      nowIso,
    );
    assert("insertDeal создал (PENDING)", dealIns.changes === 1);
    let pendingDeals = await store.listPendingDeals(W);
    assert(
      "listPendingDeals видит сделку (admin_decision=null)",
      pendingDeals.length === 1 && pendingDeals[0].admin_decision === null,
    );

    await store.decideDeal(W, "approved", "одобрено", nowIso, dealIns.id);
    pendingDeals = await store.listPendingDeals(W);
    const deal = await prisma.mktDeal.findUnique({ where: { id: dealIns.id } });
    assert(
      "decideDeal: APPROVED, ушла из pending-списка",
      deal.adminDecision === "APPROVED" && pendingDeals.length === 0,
    );

    // ─── 6. daily_counters: инкрементальный upsert ────────────────────────
    console.log("── daily counters / settings / lead_emails");
    const dateKey = "2026-06-13";
    await store.upsertDailyCounters(W, {
      date: dateKey,
      sent_email: 2,
      sent_tg: 1,
      ai_input_tokens: 100,
      ai_output_tokens: 50,
      ai_cache_read: 0,
      ai_cache_creation: 0,
    });
    await store.upsertDailyCounters(W, {
      date: dateKey,
      sent_email: 3,
      sent_tg: 0,
      ai_input_tokens: 200,
      ai_output_tokens: 70,
      ai_cache_read: 10,
      ai_cache_creation: 5,
    });
    const counter = await prisma.mktDailyCounter.findUnique({
      where: { workspaceId_dateKey: { workspaceId: W, dateKey } },
    });
    assert(
      "counters суммируются: emails=5, tg=1, in=300",
      counter.emailsSent === 5 &&
        counter.tgSent === 1 &&
        counter.tokensIn === 300,
      JSON.stringify(counter),
    );

    // settings
    await store.upsertSetting(W, "review_mode", "on", nowIso);
    await store.upsertSetting(W, "review_mode", "off", nowIso);
    const setting = await prisma.mktSetting.findUnique({
      where: { workspaceId_key: { workspaceId: W, key: "review_mode" } },
    });
    assert(
      "upsertSetting: перезаписан, не задублирован",
      setting.value === "off",
    );

    // lead_emails sync
    await store.syncLeadEmails(W, leadId, "A@ex.com; b@ex.com,a@ex.com");
    let emails = await prisma.mktLeadEmail.findMany({
      where: { leadId },
      orderBy: { email: "asc" },
    });
    assert(
      "syncLeadEmails: нормализация+дедуп (2 адреса lowercase)",
      emails.length === 2 &&
        emails[0].email === "a@ex.com" &&
        emails[1].email === "b@ex.com",
      JSON.stringify(emails.map((e) => e.email)),
    );
    await store.syncLeadEmails(W, leadId, "only@ex.com");
    emails = await prisma.mktLeadEmail.findMany({ where: { leadId } });
    assert(
      "syncLeadEmails: полная пересинхронизация (1 адрес)",
      emails.length === 1 && emails[0].email === "only@ex.com",
    );
  } finally {
    // ─── Teardown: удалить временный воркспейс (каскад чистит Mkt*) ────────
    console.log("\n── teardown");
    await prisma.workspace.delete({ where: { id: W } });
    const leftovers = await Promise.all([
      prisma.mktLead.count({ where: { workspaceId: W } }),
      prisma.mktProject.count({ where: { workspaceId: W } }),
      prisma.mktDailyCounter.count({ where: { workspaceId: W } }),
      prisma.mktSetting.count({ where: { workspaceId: W } }),
    ]);
    assert(
      "teardown: воркспейс удалён, mkt-строк не осталось",
      leftovers.every((n) => n === 0),
      JSON.stringify(leftovers),
    );
  }

  // ─── QA-воркспейс не изменён ─────────────────────────────────────────────
  const qaAfter = await qaCounts();
  assert(
    `QA не изменён (leads ${qaAfter.leads}, dialogues ${qaAfter.dialogues}, messages ${qaAfter.messages}, projects ${qaAfter.projects})`,
    JSON.stringify(qaBefore) === JSON.stringify(qaAfter),
    `before=${JSON.stringify(qaBefore)} after=${JSON.stringify(qaAfter)}`,
  );

  console.log(`\n━━━ ИТОГ: ${passed} ✓ / ${failed} ✗ ━━━\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
