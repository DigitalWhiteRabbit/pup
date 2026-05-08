export async function register() {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    // Dynamic import to avoid bundling issues
    const { getTelegramBot } = await import("@/lib/services/telegram/bot");
    getTelegramBot();
  }
}
