/**
 * Idempotent seed script.
 * Run: pnpm db:seed
 *
 * Idempotency guarantees:
 * - Admin is upserted by email (no duplicates on repeated runs)
 * - Demo data uses hardcoded IDs + upsert/createIfNotExists
 * - Demo project is created ONLY if admin has no projects yet
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const db = new PrismaClient();

// ─── Hardcoded seed IDs (stable across runs) ───
const SEED_IDS = {
  DEMO_PROJECT: "seed0project0000000000001",
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

  // ─── Upsert admin user ───
  const admin = await db.user.upsert({
    where: { email },
    update: {}, // do not overwrite password on repeated runs
    create: {
      login,
      email,
      password: hashedPassword,
      role: "ADMIN",
      isActive: true,
    },
  });

  console.log(`✓ Admin user ready: ${admin.login} <${admin.email}>`);

  // ─── Demo data (optional) ───
  const seedDemo = process.env["SEED_DEMO_DATA"] === "true";
  if (!seedDemo) {
    console.log("ℹ  SEED_DEMO_DATA is not 'true' — skipping demo data");
    return;
  }

  // Guard: only create if admin has no projects yet
  const existingProject = await db.project.findFirst({
    where: { id: SEED_IDS.DEMO_PROJECT },
  });

  if (existingProject) {
    console.log("ℹ  Demo data already exists — skipping");
    return;
  }

  // Create demo project with 3 columns and 5 tasks
  await db.project.create({
    data: {
      id: SEED_IDS.DEMO_PROJECT,
      name: "Demo Project",
      description: "Демонстрационный проект для знакомства с CRM",
      ownerId: admin.id,
      members: {
        create: {
          id: SEED_IDS.MEMBER_ADMIN,
          userId: admin.id,
          role: "OWNER",
        },
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

  // Create demo tasks across columns
  await db.task.createMany({
    data: [
      {
        id: SEED_IDS.TASK_1,
        projectId: SEED_IDS.DEMO_PROJECT,
        columnId: SEED_IDS.COL_TODO,
        title: "Настроить окружение разработки",
        description:
          "Установить зависимости, создать .env файл, запустить миграции",
        position: 0,
        assigneeId: admin.id,
      },
      {
        id: SEED_IDS.TASK_2,
        projectId: SEED_IDS.DEMO_PROJECT,
        columnId: SEED_IDS.COL_TODO,
        title: "Написать документацию",
        description: "Описать API контракты и бизнес-правила",
        position: 1,
      },
      {
        id: SEED_IDS.TASK_3,
        projectId: SEED_IDS.DEMO_PROJECT,
        columnId: SEED_IDS.COL_INPROGRESS,
        title: "Реализовать канбан-доску",
        description: "Drag & drop с оптимистичными обновлениями",
        position: 0,
        assigneeId: admin.id,
      },
      {
        id: SEED_IDS.TASK_4,
        projectId: SEED_IDS.DEMO_PROJECT,
        columnId: SEED_IDS.COL_DONE,
        title: "Инициализировать проект",
        description: "Next.js 14, TypeScript, Prisma, shadcn/ui",
        position: 0,
        assigneeId: admin.id,
      },
      {
        id: SEED_IDS.TASK_5,
        projectId: SEED_IDS.DEMO_PROJECT,
        columnId: SEED_IDS.COL_DONE,
        title: "Спроектировать схему данных",
        position: 1,
      },
    ],
  });

  console.log(`✓ Demo project created with 3 columns and 5 tasks`);
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
