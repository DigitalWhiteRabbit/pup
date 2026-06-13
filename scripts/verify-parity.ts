/**
 * verify-parity.ts — сверка yt-parser SQLite ↔ Prisma-Postgres после миграции
 * (Шаг 4 плана унификации, см. ../_docs/TZ-marketing-db-unification.md).
 *
 * Запуск: tsx scripts/verify-parity.ts
 * Exit-код ≠ 0 при любом расхождении (счётчики или точечные поля).
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   одноразовый инструмент сверки: строки SQLite нетипизированы;
   удаляется после Батча 3 вместе с миграционным скриптом */

import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import * as path from "node:path";

const WORKSPACE_ID = "cmqbkwccn0001onqtv7q6ihrd"; // "QA / Telegram Outreach"
const SQLITE_FILE = path.join(
  __dirname,
  "..",
  "tools",
  "yt-parser",
  "data",
  "ws-qa-tg.db",
);

const prisma = new PrismaClient();
const sq = new Database(SQLITE_FILE, { readonly: true, fileMustExist: true });

let failures = 0;
const mismatches: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) {
    failures++;
    mismatches.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok ? "✓" : "✗";
}

function sqCount(table: string): number {
  const row = sq.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

async function main() {
  console.log(
    `\n━━━ Паритет SQLite (ws-qa-tg.db) ↔ Prisma (workspace ${WORKSPACE_ID}) ━━━\n`,
  );

  // ─── 1. Счётчики по сущностям ──────────────────────────────────────────────
  const wsLead = { workspaceId: WORKSPACE_ID };
  const counts: Array<[string, number, number]> = [
    [
      "projects ↔ mktProject",
      sqCount("projects"),
      await prisma.mktProject.count({ where: wsLead }),
    ],
    [
      "leads ↔ mktLead",
      sqCount("leads"),
      await prisma.mktLead.count({ where: wsLead }),
    ],
    [
      "dialogues ↔ mktDialogue",
      sqCount("dialogues"),
      await prisma.mktDialogue.count({ where: { lead: wsLead } }),
    ],
    [
      "messages ↔ mktMessage",
      sqCount("messages"),
      await prisma.mktMessage.count({ where: { dialogue: { lead: wsLead } } }),
    ],
    [
      "deals ↔ mktDeal",
      sqCount("deals"),
      await prisma.mktDeal.count({ where: { lead: wsLead } }),
    ],
    [
      "pending_replies ↔ mktPendingReply",
      sqCount("pending_replies"),
      await prisma.mktPendingReply.count({ where: { lead: wsLead } }),
    ],
    [
      "lead_emails ↔ mktLeadEmail",
      sqCount("lead_emails"),
      await prisma.mktLeadEmail.count({ where: { lead: wsLead } }),
    ],
  ];

  console.log(
    `${"сущность".padEnd(36)} ${"SQLite".padStart(7)} ${"Prisma".padStart(7)}  ok`,
  );
  for (const [label, a, b] of counts) {
    const mark = check(`count ${label}`, a === b, `SQLite=${a} Prisma=${b}`);
    console.log(
      `${label.padEnd(36)} ${String(a).padStart(7)} ${String(b).padStart(7)}  ${mark}`,
    );
  }

  // ─── 2. Точечная сверка полей ──────────────────────────────────────────────
  console.log(`\n── Точечная сверка`);

  const LEAD_STATUS: Record<string, string> = {
    pending: "PENDING",
    ready: "READY",
    in_work: "IN_WORK",
    done: "DONE",
    rejected: "REJECTED",
  };
  const DIALOGUE_STAGE: Record<string, string> = {
    not_contacted: "NOT_CONTACTED",
    queued: "QUEUED",
    awaiting_review: "AWAITING_REVIEW",
    contacted: "CONTACTED",
    awaiting_reply: "AWAITING_REPLY",
    followup_1: "FOLLOWUP_1",
    followup_2: "FOLLOWUP_2",
    replied: "REPLIED",
    negotiating: "NEGOTIATING",
    deal_pending: "DEAL_PENDING",
    won: "WON",
    lost: "LOST",
    moved_to_tg: "MOVED_TO_TG",
  };
  const DIRECTION: Record<string, string> = { in: "IN", out: "OUT" };
  const SENDER: Record<string, string> = {
    agent: "AGENT",
    admin: "ADMIN",
    blogger: "EXTERNAL",
  };

  // 2.1 Лиды (первые 2 по id): channelName, leadStatus, dialogueStage
  const sqLeads = sq
    .prepare(`SELECT * FROM leads ORDER BY id LIMIT 2`)
    .all() as any[];

  for (const l of sqLeads) {
    const pLead = await prisma.mktLead.findUnique({
      where: {
        workspaceId_channelId: {
          workspaceId: WORKSPACE_ID,
          channelId: String(l.channel_id),
        },
      },
    });
    if (!pLead) {
      console.log(
        `  lead ${l.channel_id}: ${check(`lead ${l.channel_id} существует`, false, "не найден в Prisma")}`,
      );
      continue;
    }
    const expStatus =
      LEAD_STATUS[(l.lead_status ?? "").toLowerCase()] ?? "PENDING";
    const expStage =
      DIALOGUE_STAGE[(l.dialogue_stage ?? "").toLowerCase()] ?? "NOT_CONTACTED";
    console.log(`  lead ${l.channel_id}:`);
    console.log(
      `    channelName  "${l.channel_name}" ↔ "${pLead.channelName}"  ${check(`lead ${l.channel_id} channelName`, (l.channel_name ?? null) === pLead.channelName)}`,
    );
    console.log(
      `    leadStatus   ${l.lead_status} → ${expStatus} ↔ ${pLead.leadStatus}  ${check(`lead ${l.channel_id} leadStatus`, pLead.leadStatus === expStatus)}`,
    );
    console.log(
      `    dialogueStage ${l.dialogue_stage} → ${expStage} ↔ ${pLead.dialogueStage}  ${check(`lead ${l.channel_id} dialogueStage`, pLead.dialogueStage === expStage)}`,
    );
  }

  // 2.2 Сообщения (первые 2): content, direction, sender
  const sqMsgs = sq
    .prepare(
      `SELECT m.*, d.lead_id, d.channel AS d_channel, d.external_thread_id
       FROM messages m JOIN dialogues d ON d.id = m.dialogue_id
       ORDER BY m.id LIMIT 2`,
    )
    .all() as any[];

  for (const m of sqMsgs) {
    const expDir = DIRECTION[(m.direction ?? "").toLowerCase()] ?? "IN";
    const expSender = SENDER[(m.sender ?? "").toLowerCase()] ?? "EXTERNAL";
    const pMsg = await prisma.mktMessage.findFirst({
      where: {
        content: m.content ?? "",
        createdAt: new Date(m.created_at),
        dialogue: { lead: { workspaceId: WORKSPACE_ID } },
      },
    });
    if (!pMsg) {
      console.log(
        `  message #${m.id}: ${check(`message #${m.id} существует`, false, "не найдено в Prisma")}`,
      );
      continue;
    }
    console.log(`  message #${m.id}:`);
    console.log(
      `    content   ${check(`message #${m.id} content`, pMsg.content === (m.content ?? ""))} (${String(m.content).slice(0, 40)}…)`,
    );
    console.log(
      `    direction ${m.direction} → ${expDir} ↔ ${pMsg.direction}  ${check(`message #${m.id} direction`, pMsg.direction === expDir)}`,
    );
    console.log(
      `    sender    ${m.sender} → ${expSender} ↔ ${pMsg.sender}  ${check(`message #${m.id} sender`, pMsg.sender === expSender)}`,
    );
  }

  // 2.3 analysis_*: если есть в SQLite — должна быть MktLeadAnalysis с теми же score/verdict
  const sqAnalysis = sq
    .prepare(
      `SELECT * FROM leads
       WHERE analysis_score IS NOT NULL OR analysis_verdict IS NOT NULL
          OR analysis_metrics IS NOT NULL OR analyzed_at IS NOT NULL
       ORDER BY id LIMIT 2`,
    )
    .all() as any[];

  if (sqAnalysis.length === 0) {
    console.log(
      `  analysis_*: в SQLite нет лидов с анализом — сверка не требуется ✓`,
    );
  } else {
    for (const l of sqAnalysis) {
      const pLead = await prisma.mktLead.findUnique({
        where: {
          workspaceId_channelId: {
            workspaceId: WORKSPACE_ID,
            channelId: String(l.channel_id),
          },
        },
        include: { analysis: true },
      });
      const a = pLead?.analysis;
      console.log(`  analysis для ${l.channel_id}:`);
      console.log(
        `    запись есть ${check(`analysis ${l.channel_id} существует`, !!a)}`,
      );
      if (a) {
        console.log(
          `    score   ${l.analysis_score} ↔ ${a.score}  ${check(`analysis ${l.channel_id} score`, (l.analysis_score ?? null) === a.score)}`,
        );
        console.log(
          `    verdict "${l.analysis_verdict}" ↔ "${a.verdict}"  ${check(`analysis ${l.channel_id} verdict`, (l.analysis_verdict ?? null) === a.verdict)}`,
        );
      }
    }
  }

  // 2.4 lead_emails: полное совпадение множеств адресов
  const sqEmails = sq
    .prepare(
      `SELECT le.email, l.channel_id FROM lead_emails le JOIN leads l ON l.id = le.lead_id ORDER BY le.email`,
    )
    .all() as any[];
  const pEmails = await prisma.mktLeadEmail.findMany({
    where: { lead: { workspaceId: WORKSPACE_ID } },
    include: { lead: { select: { channelId: true } } },
    orderBy: { email: "asc" },
  });
  const sqSet = sqEmails.map((e) => `${e.channel_id}|${e.email}`).sort();
  const pSet = pEmails.map((e) => `${e.lead.channelId}|${e.email}`).sort();
  const emailsOk = JSON.stringify(sqSet) === JSON.stringify(pSet);
  console.log(
    `  lead_emails: ${sqSet.length} адресов, множества ${check("lead_emails множества", emailsOk, `SQLite=[${sqSet}] Prisma=[${pSet}]`)} ${emailsOk ? "совпадают" : "РАСХОДЯТСЯ"}`,
  );

  // ─── Итог ──────────────────────────────────────────────────────────────────
  if (failures === 0) {
    console.log(`\n━━━ ПАРИТЕТ ✓ — расхождений нет ━━━\n`);
  } else {
    console.log(`\n━━━ ПАРИТЕТ ✗ — расхождений: ${failures} ━━━`);
    for (const m of mismatches) console.log(`  ✗ ${m}`);
    console.log("");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    sq.close();
    return prisma.$disconnect();
  });
