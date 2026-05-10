export async function register() {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
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

    setInterval(
      () => {
        checkSlaBreaches().catch((e) => console.error("[SLA check] Failed", e));
      },
      5 * 60 * 1000,
    );

    // Daily cleanup every 24 hours
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
    );
  }
}
