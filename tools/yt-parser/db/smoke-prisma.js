/**
 * smoke-prisma.js — проверка чтения yt-parser'ом единого Prisma-Postgres PUP.
 * Только чтение, ничего не пишет. Запуск: node db/smoke-prisma.js
 */
require("dotenv").config();
const { PrismaClient } = require("./generated/prisma");
const { resolveWorkspaceId } = require("./workspace-map");

const prisma = new PrismaClient();

async function main() {
  const wsId = resolveWorkspaceId("qa-tg");
  if (!wsId) throw new Error('Ключ "qa-tg" не разрезолвился в workspace-map');

  console.log(`\n━━━ Smoke: чтение Prisma-Postgres (workspace ${wsId}) ━━━\n`);

  const [leads, dialogues, messages, projects] = await Promise.all([
    prisma.mktLead.count({ where: { workspaceId: wsId } }),
    prisma.mktDialogue.count({ where: { lead: { workspaceId: wsId } } }),
    prisma.mktMessage.count({
      where: { dialogue: { lead: { workspaceId: wsId } } },
    }),
    prisma.mktProject.count({ where: { workspaceId: wsId } }),
  ]);

  const rows = [
    ["leads", leads, 5],
    ["dialogues", dialogues, 3],
    ["messages", messages, 12],
    ["projects", projects, 1],
  ];

  let failed = 0;
  console.log(
    `${"сущность".padEnd(12)} ${"факт".padStart(5)} ${"ожид.".padStart(6)}  ok`,
  );
  for (const [name, actual, expected] of rows) {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(
      `${name.padEnd(12)} ${String(actual).padStart(5)} ${String(expected).padStart(6)}  ${ok ? "✓" : "✗"}`,
    );
  }

  const lead = await prisma.mktLead.findFirst({
    where: { workspaceId: wsId },
    select: { channelId: true, channelName: true },
    orderBy: { channelId: "asc" },
  });
  const nameOk = !!(lead && lead.channelName);
  if (!nameOk) failed++;
  console.log(
    `\nПервый лид: ${lead ? `${lead.channelId} → "${lead.channelName}"` : "НЕ НАЙДЕН"}  ${nameOk ? "✓" : "✗"}`,
  );

  if (failed) {
    console.log(`\n━━━ SMOKE ✗ — расхождений: ${failed} ━━━\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n━━━ SMOKE ✓ — парсер читает единый Postgres ━━━\n`);
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
