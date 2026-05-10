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
