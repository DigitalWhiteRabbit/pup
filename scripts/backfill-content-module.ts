/**
 * One-off backfill: ensure every existing Workspace has a "content"
 * WorkspaceModule row (enabled), so the Контент-план module shows up.
 * New workspaces get it automatically via DEFAULT_MODULES.
 *
 * Run: pnpm tsx scripts/backfill-content-module.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const workspaces = await db.workspace.findMany({ select: { id: true } });
  for (const ws of workspaces) {
    await db.workspaceModule.upsert({
      where: {
        workspaceId_moduleKey: { workspaceId: ws.id, moduleKey: "content" },
      },
      update: {},
      create: { workspaceId: ws.id, moduleKey: "content", enabled: true },
    });
  }
  console.log(
    `[backfill] content module ensured for ${workspaces.length} workspace(s)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void db.$disconnect());
