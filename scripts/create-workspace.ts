/**
 * create-workspace.ts — идемпотентное создание QA-воркспейса под миграцию
 * маркетинговых данных yt-parser (см. ../_docs/TZ-marketing-db-unification.md).
 *
 * Запуск: tsx scripts/create-workspace.ts
 * Печатает cuid воркспейса (для WORKSPACE_MAP в migrate-ytparser-to-prisma.ts).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const WS_NAME = "QA / Telegram Outreach";
const WS_SLUG = "qa-telegram";

// Дефолтные модули — как в prisma/seed.ts
const DEFAULT_MODULES = [
  "crm",
  "knowledge",
  "tickets",
  "logs",
  "chat",
  "marketing",
  "analytics",
  "users",
] as const;

async function main() {
  const adminEmail = process.env["INITIAL_ADMIN_EMAIL"];
  if (!adminEmail) {
    throw new Error(
      "INITIAL_ADMIN_EMAIL не задан в .env — некому владеть воркспейсом",
    );
  }

  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    throw new Error(
      `Админ <${adminEmail}> не найден. Сначала выполните: pnpm db:seed`,
    );
  }

  // Воркспейс: если slug уже занят — берём существующий, не дублируем
  let ws = await prisma.workspace.findUnique({ where: { slug: WS_SLUG } });
  if (ws) {
    console.log(
      `ℹ Воркспейс со slug "${WS_SLUG}" уже существует — используем его`,
    );
  } else {
    ws = await prisma.workspace.create({
      data: {
        name: WS_NAME,
        slug: WS_SLUG,
        description:
          "QA-воркспейс под мигрируемые данные yt-parser (Telegram outreach)",
        ownerId: admin.id,
      },
    });
    console.log(`✓ Создан воркспейс "${WS_NAME}"`);
  }

  // Membership владельца (OWNER) — идемпотентно
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId: ws.id, userId: admin.id },
  });
  if (member) {
    console.log(`ℹ Membership админа уже есть (role=${member.role})`);
  } else {
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: admin.id, role: "OWNER" },
    });
    console.log(`✓ Membership OWNER для ${admin.login} добавлен`);
  }

  // Дефолтные модули — идемпотентно, досоздаём недостающие
  const existing = await prisma.workspaceModule.findMany({
    where: { workspaceId: ws.id },
    select: { moduleKey: true },
  });
  const have = new Set(existing.map((m) => m.moduleKey));
  const missing = DEFAULT_MODULES.filter((k) => !have.has(k));
  if (missing.length) {
    await prisma.workspaceModule.createMany({
      data: missing.map((moduleKey) => ({
        workspaceId: ws.id,
        moduleKey,
        enabled: true,
      })),
    });
    console.log(`✓ Модули включены: ${missing.join(", ")}`);
  } else {
    console.log(`ℹ Все ${DEFAULT_MODULES.length} модулей уже включены`);
  }

  console.log(`\nWorkspace cuid: ${ws.id}`);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
