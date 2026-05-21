/** Tracked intervals so we can clear them on shutdown */
const activeIntervals: ReturnType<typeof setInterval>[] = [];
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[shutdown] ${signal} received — starting graceful shutdown`);

  // 1. Clear all setIntervals
  for (const id of activeIntervals) {
    clearInterval(id);
  }
  activeIntervals.length = 0;
  console.log("[shutdown] Cleared all intervals");

  // 2. Stop marketing worker (hidden from webpack static analysis)
  try {
    const modPath = "@/lib/services/marketing/mkt-worker.service";
    const mod = await (Function("p", "return import(p)")(modPath) as Promise<{
      stop: () => Promise<void>;
    }>);
    await mod.stop();
    console.log("[shutdown] Marketing worker stopped");
  } catch {
    // Worker may not have been running — that's fine
  }

  // 3. Disconnect Prisma
  try {
    const { db } = await import("@/lib/db");
    await db.$disconnect();
    console.log("[shutdown] Prisma disconnected");
  } catch (e) {
    console.error("[shutdown] Prisma disconnect failed:", e);
  }

  console.log("[shutdown] Graceful shutdown complete");
  process.exit(0);
}

export async function register() {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    // --- Environment validation (fail fast on bad config) ---
    await import("@/lib/env");

    // --- Graceful shutdown handlers ---
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Dynamic import to avoid bundling issues
    const { getTelegramBot } = await import("@/lib/services/telegram/bot");
    getTelegramBot();

    const { db } = await import("@/lib/db");
    db.kbCrawl
      .updateMany({
        where: { status: "RUNNING" },
        data: {
          status: "FAILED",
          error: "Сервер был перезапущен во время выполнения crawl",
          completedAt: new Date(),
        },
      })
      .then((r) => {
        if (r.count > 0)
          console.log(
            `[Crawl cleanup] Marked ${r.count} stuck crawls as FAILED`,
          );
      })
      .catch((e) => console.error("[Crawl cleanup] Failed:", e));

    // Mark deploy as completed (new instance just started)
    const { onDeployCompleted } =
      await import("@/lib/services/telegram/deploy");
    void onDeployCompleted();

    const { cleanupOldLogs } = await import("@/lib/services/logger.service");

    // Initial cleanup on startup
    cleanupOldLogs()
      .then((result) => {
        console.log(
          `[Logs cleanup] Initial: deleted ${result.activityDeleted} activity, ${result.systemDeleted} system logs`,
        );
      })
      .catch((err) => console.error("[Logs cleanup] Initial failed", err));

    // SLA breach check every 5 minutes
    const { checkSlaBreaches } =
      await import("@/lib/services/tickets/sla-check.service");
    checkSlaBreaches()
      .then((r) => {
        if (r.breached > 0)
          console.log(`[SLA check] Initial: ${r.breached} tickets breached`);
      })
      .catch((e) => console.error("[SLA check] Initial failed", e));

    activeIntervals.push(
      setInterval(
        () => {
          checkSlaBreaches().catch((e) =>
            console.error("[SLA check] Failed", e),
          );
        },
        5 * 60 * 1000,
      ),
    );

    // Daily cleanup every 24 hours
    activeIntervals.push(
      setInterval(
        () => {
          cleanupOldLogs()
            .then((result) => {
              console.log(
                `[Logs cleanup] Daily: deleted ${result.activityDeleted} activity, ${result.systemDeleted} system logs`,
              );
            })
            .catch((err) => console.error("[Logs cleanup] Daily failed", err));
        },
        24 * 60 * 60 * 1000,
      ),
    );
  }
}
