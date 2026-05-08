import TelegramBot from "node-telegram-bot-api";

let _bot: TelegramBot | null = null;

async function getDb() {
  const { db } = await import("@/lib/db");
  return db;
}

function setupHandlers(bot: TelegramBot): void {
  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const code = match?.[1]?.trim();

    if (!code) {
      await bot.sendMessage(
        chatId,
        "Неверный формат. Используйте: /start <код>",
      );
      return;
    }

    try {
      const db = await getDb();

      const token = await db.telegramLinkToken.findUnique({
        where: { token: code },
        include: { user: { select: { id: true, login: true } } },
      });

      if (!token) {
        await bot.sendMessage(
          chatId,
          "Код не найден. Сгенерируйте новый код в настройках профиля.",
        );
        return;
      }

      if (token.expiresAt < new Date()) {
        await db.telegramLinkToken.delete({ where: { id: token.id } });
        await bot.sendMessage(
          chatId,
          "Код истёк (срок жизни 10 минут). Сгенерируйте новый.",
        );
        return;
      }

      const existing = await db.user.findFirst({
        where: { telegramChatId: chatId, NOT: { id: token.userId } },
      });

      if (existing) {
        await bot.sendMessage(
          chatId,
          "Этот Telegram уже привязан к другому аккаунту.",
        );
        return;
      }

      await db.$transaction([
        db.user.update({
          where: { id: token.userId },
          data: { telegramChatId: chatId },
        }),
        db.telegramLinkToken.delete({ where: { id: token.id } }),
      ]);

      await bot.sendMessage(
        chatId,
        `Telegram привязан к аккаунту <b>${token.user.login}</b>!\n\nТеперь вы будете получать уведомления о событиях в CRM.`,
        { parse_mode: "HTML" },
      );
    } catch (error) {
      console.error("[Telegram bot] Error handling /start:", error);
      await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    }
  });

  bot.onText(/\/start$/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot.sendMessage(
      chatId,
      "Для привязки аккаунта используйте команду:\n/start <код>\n\nКод можно получить в настройках профиля CRM.",
    );
  });

  bot.on("polling_error", (error) => {
    console.error("[Telegram polling]", error.message);
  });
}

export function getTelegramBot(): TelegramBot | null {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN not set, bot disabled");
    return null;
  }

  if (!_bot) {
    _bot = new TelegramBot(token, { polling: true });
    setupHandlers(_bot);
    console.log("[Telegram] Bot started in polling mode");
  }

  return _bot;
}
