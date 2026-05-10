/**
 * Idempotent seed script.
 * Run: pnpm db:seed
 * Run with demo data: SEED_DEMO_DATA=true pnpm db:seed
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const db = new PrismaClient();

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

const SEED_IDS = {
  DEMO_WORKSPACE: "seed0workspace000000001",
  COL_TODO: "seed0col0todo00000000001",
  COL_INPROGRESS: "seed0col0inprogress00001",
  COL_DONE: "seed0col0done00000000001",
  TASK_1: "seed0task000000000000001",
  TASK_2: "seed0task000000000000002",
  TASK_3: "seed0task000000000000003",
  TASK_4: "seed0task000000000000004",
  TASK_5: "seed0task000000000000005",
  MEMBER_ADMIN: "seed0member0admin000001",
} as const;

async function main() {
  const login = process.env["INITIAL_ADMIN_LOGIN"];
  const email = process.env["INITIAL_ADMIN_EMAIL"];
  const password = process.env["INITIAL_ADMIN_PASSWORD"];

  if (!login || !email || !password) {
    throw new Error(
      "Missing required env vars: INITIAL_ADMIN_LOGIN, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD",
    );
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const admin = await db.user.upsert({
    where: { email },
    update: {},
    create: {
      login,
      email,
      password: hashedPassword,
      role: "ADMIN",
      isActive: true,
    },
  });

  console.log(`✓ Admin user ready: ${admin.login} <${admin.email}>`);

  const seedDemo = process.env["SEED_DEMO_DATA"] === "true";
  if (!seedDemo) {
    console.log("ℹ  SEED_DEMO_DATA is not 'true' — skipping demo data");
    return;
  }

  const existing = await db.workspace.findFirst({
    where: { id: SEED_IDS.DEMO_WORKSPACE },
  });

  if (existing) {
    console.log("ℹ  Demo data already exists — skipping");
    return;
  }

  await db.workspace.create({
    data: {
      id: SEED_IDS.DEMO_WORKSPACE,
      name: "Demo Workspace",
      slug: "demo-workspace-seed01",
      description: "Демонстрационное рабочее пространство со всеми модулями",
      ownerId: admin.id,
      members: {
        create: {
          id: SEED_IDS.MEMBER_ADMIN,
          userId: admin.id,
          role: "OWNER",
        },
      },
      modules: {
        create: DEFAULT_MODULES.map((moduleKey) => ({
          moduleKey,
          enabled: true,
        })),
      },
      columns: {
        create: [
          { id: SEED_IDS.COL_TODO, name: "К выполнению", position: 0 },
          { id: SEED_IDS.COL_INPROGRESS, name: "В работе", position: 1 },
          { id: SEED_IDS.COL_DONE, name: "Готово", position: 2 },
        ],
      },
    },
  });

  await db.task.createMany({
    data: [
      {
        id: SEED_IDS.TASK_1,
        workspaceId: SEED_IDS.DEMO_WORKSPACE,
        columnId: SEED_IDS.COL_TODO,
        title: "Настроить окружение разработки",
        description:
          "Установить зависимости, создать .env файл, запустить миграции",
        position: 0,
      },
      {
        id: SEED_IDS.TASK_2,
        workspaceId: SEED_IDS.DEMO_WORKSPACE,
        columnId: SEED_IDS.COL_TODO,
        title: "Написать документацию",
        description: "Описать API контракты и бизнес-правила",
        position: 1,
      },
      {
        id: SEED_IDS.TASK_3,
        workspaceId: SEED_IDS.DEMO_WORKSPACE,
        columnId: SEED_IDS.COL_INPROGRESS,
        title: "Реализовать канбан-доску",
        description: "Drag & drop с оптимистичными обновлениями",
        position: 0,
      },
      {
        id: SEED_IDS.TASK_4,
        workspaceId: SEED_IDS.DEMO_WORKSPACE,
        columnId: SEED_IDS.COL_DONE,
        title: "Инициализировать проект",
        description: "Next.js 14, TypeScript, Prisma, shadcn/ui",
        position: 0,
      },
      {
        id: SEED_IDS.TASK_5,
        workspaceId: SEED_IDS.DEMO_WORKSPACE,
        columnId: SEED_IDS.COL_DONE,
        title: "Спроектировать схему данных",
        position: 1,
      },
    ],
  });

  console.log(
    `✓ Demo workspace created with 3 columns, 8 modules, and 5 tasks`,
  );
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
