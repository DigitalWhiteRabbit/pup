import TelegramBot from "node-telegram-bot-api";
import type { TaskPriority } from "@prisma/client";

// Use global to survive Next.js hot reloads (dev only)
const globalForBot = globalThis as unknown as {
  __tgBot?: TelegramBot;
  __tgBotInitialized?: boolean;
};

// Pending input state per chat
type PendingAction =
  | { type: "comment"; taskId: string }
  | { type: "new_task_title"; workspaceId: string; columnId: string };

const pendingActions = new Map<string, PendingAction>();

async function getDb() {
  const { db } = await import("@/lib/db");
  return db;
}

async function getUserByChatId(chatId: string) {
  const db = await getDb();
  return db.user.findFirst({
    where: { telegramChatId: chatId },
    select: { id: true, login: true, role: true },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRIORITY_EMOJI: Record<string, string> = {
  NONE: "⚪",
  LOW: "🔵",
  MEDIUM: "🟡",
  HIGH: "🟠",
  URGENT: "🔴",
};

const PRIORITY_LABEL: Record<string, string> = {
  NONE: "Без приоритета",
  LOW: "Низкий",
  MEDIUM: "Средний",
  HIGH: "Высокий",
  URGENT: "Срочный",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sendTaskCard(bot: TelegramBot, chatId: string, taskId: string) {
  const db = await getDb();
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      column: { select: { name: true } },
      workspace: { select: { name: true } },
      assignees: { include: { user: { select: { login: true } } } },
      checklistItems: { orderBy: { position: "asc" } },
      comments: {
        orderBy: { createdAt: "desc" },
        take: 3,
        include: { author: { select: { login: true } } },
      },
    },
  });

  if (!task) {
    await bot.sendMessage(chatId, "Задача не найдена.");
    return;
  }

  const prio = `${PRIORITY_EMOJI[task.priority] ?? "⚪"} ${PRIORITY_LABEL[task.priority] ?? task.priority}`;
  const assignees = task.assignees.map((a) => a.user.login).join(", ") || "—";
  const checkDone = task.checklistItems.filter((i) => i.checked).length;
  const checkTotal = task.checklistItems.length;

  const lines: string[] = [
    `<b>📋 ${escapeHtml(task.title)}</b>`,
    ``,
    `📁 ${escapeHtml(task.workspace.name)} → <b>${escapeHtml(task.column.name)}</b>`,
    `${prio}`,
    `👥 ${escapeHtml(assignees)}`,
  ];

  if (task.dueDate) {
    const d = new Date(task.dueDate).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    lines.push(`⏰ Дедлайн: ${d}`);
  }

  if (task.description) {
    const short =
      task.description.length > 150
        ? task.description.slice(0, 150) + "…"
        : task.description;
    lines.push(`\n📝 ${escapeHtml(short)}`);
  }

  if (checkTotal > 0) {
    lines.push(`\n☑️ <b>Чек-лист (${checkDone}/${checkTotal}):</b>`);
    for (const item of task.checklistItems) {
      lines.push(`  ${item.checked ? "✅" : "⬜"} ${escapeHtml(item.text)}`);
    }
  }

  if (task.comments.length > 0) {
    lines.push(`\n💬 <b>Последние комментарии:</b>`);
    for (const c of task.comments.reverse()) {
      const time = new Date(c.createdAt).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(
        `  <b>${escapeHtml(c.author.login)}</b> (${time}): ${escapeHtml(c.text.length > 80 ? c.text.slice(0, 80) + "…" : c.text)}`,
      );
    }
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "💬 Комментировать", callback_data: `comment:${taskId}` },
      { text: "🔄 Переместить", callback_data: `move:${taskId}` },
    ],
    [{ text: "🔴 Приоритет", callback_data: `prio:${taskId}` }],
  ];

  if (checkTotal > 0) {
    keyboard[1]!.push({
      text: "☑️ Чек-лист",
      callback_data: `checklist:${taskId}`,
    });
  }

  keyboard.push([{ text: "🔄 Обновить", callback_data: `refresh:${taskId}` }]);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

function setupHandlers(bot: TelegramBot): void {
  // ─── /start <code> — link Telegram account ────────────────────────────
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
        `Telegram привязан к аккаунту <b>${token.user.login}</b>!\n\nДоступные команды:\n/tasks — мои задачи\n/my — сводка\n/help — справка`,
        { parse_mode: "HTML" },
      );
    } catch (error) {
      console.error("[Telegram bot] /start error:", error);
      await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    }
  });

  bot.onText(/\/start$/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot.sendMessage(
      chatId,
      "Для привязки аккаунта используйте: /start <код>\nКод — в настройках профиля CRM.",
    );
  });

  // ─── /help ────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot.sendMessage(
      chatId,
      [
        "<b>📖 Команды бота</b>",
        "",
        "/tasks — список ваших задач",
        "/my — сводка (задачи в работе, дедлайны)",
        "/cancel — отмена текущего действия",
        "/help — эта справка",
        "",
        "В уведомлениях и карточках задач используйте inline-кнопки для быстрых действий.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  // ─── /cancel ──────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (pendingActions.has(chatId)) {
      pendingActions.delete(chatId);
      await bot.sendMessage(chatId, "Отменено.");
    } else {
      await bot.sendMessage(chatId, "Нет активных действий для отмены.");
    }
  });

  // ─── /my — summary ───────────────────────────────────────────────────
  bot.onText(/\/my/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = await getUserByChatId(chatId);
    if (!user) {
      await bot.sendMessage(
        chatId,
        "Аккаунт не привязан. Используйте /start <код>.",
      );
      return;
    }

    try {
      const db = await getDb();
      const assignments = await db.taskAssignee.findMany({
        where: { userId: user.id },
        include: {
          task: {
            include: {
              column: { select: { name: true } },
              workspace: { select: { name: true } },
            },
          },
        },
      });

      const tasks = assignments.map((a) => a.task);
      const inProgress = tasks.filter((t) => t.column.name === "В работе");
      const waiting = tasks.filter((t) => t.column.name === "Ожидает");
      const overdue = tasks.filter(
        (t) =>
          t.dueDate &&
          new Date(t.dueDate) < new Date() &&
          t.column.name !== "Готово",
      );

      const unread = await db.notification.count({
        where: { recipientId: user.id, isRead: false },
      });

      const lines = [
        `<b>📊 Сводка — ${escapeHtml(user.login)}</b>`,
        ``,
        `📋 Всего задач: <b>${tasks.length}</b>`,
        `🔨 В работе: <b>${inProgress.length}</b>`,
        `⏳ Ожидают: <b>${waiting.length}</b>`,
      ];

      if (overdue.length > 0) {
        lines.push(`🔥 Просрочено: <b>${overdue.length}</b>`);
        for (const t of overdue.slice(0, 5)) {
          const d = new Date(t.dueDate!).toLocaleDateString("ru-RU", {
            day: "2-digit",
            month: "short",
          });
          lines.push(`  ⚠️ ${escapeHtml(t.title)} (${d})`);
        }
      }

      if (unread > 0) {
        lines.push(`\n🔔 Непрочитанных уведомлений: <b>${unread}</b>`);
      }

      const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
      if (tasks.length > 0) {
        keyboard.push([{ text: "📋 Мои задачи", callback_data: "cmd:tasks" }]);
      }

      await bot.sendMessage(chatId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup:
          keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (error) {
      console.error("[Telegram bot] /my error:", error);
      await bot.sendMessage(chatId, "Ошибка при загрузке сводки.");
    }
  });

  // ─── /tasks — list tasks grouped by project ───────────────────────────
  bot.onText(/\/tasks/, async (msg) => {
    const chatId = String(msg.chat.id);
    await sendTasksList(bot, chatId);
  });

  // ─── Callback query router ────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = String(query.message?.chat.id);
    const messageId = query.message?.message_id;
    const data = query.data ?? "";

    try {
      // Route by prefix
      if (data === "cmd:tasks") {
        await bot.answerCallbackQuery(query.id);
        await sendTasksList(bot, chatId);
        return;
      }

      if (data.startsWith("task:")) {
        await bot.answerCallbackQuery(query.id);
        await sendTaskCard(bot, chatId, data.slice(5));
        return;
      }

      if (data.startsWith("refresh:")) {
        await bot.answerCallbackQuery(query.id, { text: "Обновлено" });
        if (messageId) {
          await bot.deleteMessage(chatId, messageId);
        }
        await sendTaskCard(bot, chatId, data.slice(8));
        return;
      }

      if (data.startsWith("comment:")) {
        await handleCommentStart(bot, query, chatId, data.slice(8));
        return;
      }

      if (data.startsWith("move:")) {
        await handleMoveStart(bot, query, chatId, data.slice(5));
        return;
      }

      if (data.startsWith("moveto:")) {
        await handleMoveTo(bot, query, chatId, data.slice(7), messageId);
        return;
      }

      if (data.startsWith("prio:")) {
        await handlePrioStart(bot, query, chatId, data.slice(5));
        return;
      }

      if (data.startsWith("setprio:")) {
        await handleSetPrio(bot, query, chatId, data.slice(8), messageId);
        return;
      }

      if (data.startsWith("checklist:")) {
        await handleChecklistShow(bot, query, chatId, data.slice(10));
        return;
      }

      if (data.startsWith("toggle:")) {
        await handleToggleChecklist(
          bot,
          query,
          chatId,
          data.slice(7),
          messageId,
        );
        return;
      }

      if (data.startsWith("backto:")) {
        await bot.answerCallbackQuery(query.id);
        if (messageId) await bot.deleteMessage(chatId, messageId);
        await sendTaskCard(bot, chatId, data.slice(7));
        return;
      }

      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error("[Telegram bot] callback error:", error);
      await bot.answerCallbackQuery(query.id, {
        text: "Произошла ошибка",
        show_alert: true,
      });
    }
  });

  // ─── Text message — handle pending actions ────────────────────────────
  bot.on("message", async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim();
    if (!text || text.startsWith("/")) return;

    const action = pendingActions.get(chatId);
    if (!action) return;

    pendingActions.delete(chatId);

    if (action.type === "comment") {
      await handleCommentSubmit(bot, chatId, action.taskId, text);
    } else if (action.type === "new_task_title") {
      await handleNewTaskSubmit(
        bot,
        chatId,
        action.workspaceId,
        action.columnId,
        text,
      );
    }
  });

  bot.on("polling_error", (error) => {
    console.error("[Telegram polling]", error.message);
  });
}

// ─── /tasks list ────────────────────────────────────────────────────────────

async function sendTasksList(bot: TelegramBot, chatId: string) {
  const user = await getUserByChatId(chatId);
  if (!user) {
    await bot.sendMessage(
      chatId,
      "Аккаунт не привязан. Используйте /start <код>.",
    );
    return;
  }

  try {
    const db = await getDb();
    const assignments = await db.taskAssignee.findMany({
      where: { userId: user.id },
      include: {
        task: {
          include: {
            column: { select: { name: true } },
            workspace: { select: { id: true, name: true } },
          },
        },
      },
    });

    const tasks = assignments
      .map((a) => a.task)
      .filter((t) => t.column.name !== "Готово" && t.column.name !== "Архив");

    if (tasks.length === 0) {
      await bot.sendMessage(chatId, "У вас нет активных задач.");
      return;
    }

    // Group by project
    const byProject = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const key = t.workspace.name;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(t);
    }

    const lines: string[] = [`<b>📋 Ваши задачи (${tasks.length})</b>`];

    const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

    for (const [projectName, projectTasks] of Array.from(byProject.entries())) {
      lines.push(`\n<b>📁 ${escapeHtml(projectName)}</b>`);

      for (const t of projectTasks) {
        const pEmoji = PRIORITY_EMOJI[t.priority] ?? "⚪";
        const col = t.column.name;
        const due = t.dueDate
          ? ` ⏰${new Date(t.dueDate).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}`
          : "";
        lines.push(
          `  ${pEmoji} ${escapeHtml(t.title)} [${escapeHtml(col)}]${due}`,
        );

        keyboard.push([
          {
            text: `${pEmoji} ${t.title.slice(0, 40)}`,
            callback_data: `task:${t.id}`,
          },
        ]);
      }
    }

    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (error) {
    console.error("[Telegram bot] /tasks error:", error);
    await bot.sendMessage(chatId, "Ошибка при загрузке задач.");
  }
}

// ─── Comment handlers ───────────────────────────────────────────────────────

async function handleCommentStart(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  taskId: string,
) {
  const user = await getUserByChatId(chatId);
  if (!user) {
    await bot.answerCallbackQuery(query.id, {
      text: "Аккаунт не привязан",
      show_alert: true,
    });
    return;
  }

  const db = await getDb();
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { title: true },
  });

  if (!task) {
    await bot.answerCallbackQuery(query.id, {
      text: "Задача не найдена",
      show_alert: true,
    });
    return;
  }

  pendingActions.set(chatId, { type: "comment", taskId });

  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(
    chatId,
    `Напишите комментарий к задаче:\n<i>${escapeHtml(task.title)}</i>\n\n/cancel — отмена`,
    {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    },
  );
}

async function handleCommentSubmit(
  bot: TelegramBot,
  chatId: string,
  taskId: string,
  text: string,
) {
  try {
    const db = await getDb();
    const user = await getUserByChatId(chatId);
    if (!user) {
      await bot.sendMessage(chatId, "Аккаунт не привязан.");
      return;
    }

    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        workspaceId: true,
        assignees: { select: { userId: true } },
      },
    });
    if (!task) {
      await bot.sendMessage(chatId, "Задача не найдена.");
      return;
    }

    const membership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: task.workspaceId, userId: user.id },
      },
    });
    if (!membership) {
      await bot.sendMessage(chatId, "Нет доступа к проекту.");
      return;
    }

    await db.comment.create({
      data: { taskId, authorId: user.id, text },
    });

    await bot.sendMessage(
      chatId,
      `✅ Комментарий добавлен к задаче <i>${escapeHtml(task.title)}</i>`,
      { parse_mode: "HTML" },
    );

    const { notify } = await import("@/lib/services/notification.service");
    for (const a of task.assignees) {
      if (a.userId !== user.id) {
        void notify({
          type: "COMMENTED",
          recipientId: a.userId,
          actorId: user.id,
          taskId,
          workspaceId: task.workspaceId,
          extra: { commentText: text },
        });
      }
    }
  } catch (error) {
    console.error("[Telegram bot] comment submit error:", error);
    await bot.sendMessage(chatId, "Не удалось добавить комментарий.");
  }
}

// ─── Move handlers ──────────────────────────────────────────────────────────

async function handleMoveStart(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  taskId: string,
) {
  const db = await getDb();
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { columnId: true, column: { select: { workspaceId: true } } },
  });
  if (!task) {
    await bot.answerCallbackQuery(query.id, {
      text: "Задача не найдена",
      show_alert: true,
    });
    return;
  }

  const columns = await db.column.findMany({
    where: { workspaceId: task.column.workspaceId },
    orderBy: { position: "asc" },
  });

  const keyboard: TelegramBot.InlineKeyboardButton[][] = columns
    .filter((c) => c.id !== task.columnId)
    .map((c) => [
      { text: `➡️ ${c.name}`, callback_data: `moveto:${taskId}:${c.id}` },
    ]);

  keyboard.push([{ text: "⬅️ Назад", callback_data: `backto:${taskId}` }]);

  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(chatId, "Переместить в колонку:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleMoveTo(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  payload: string,
  messageId?: number,
) {
  const parts = payload.split(":");
  const taskId = parts[0]!;
  const columnId = parts[1]!;
  const user = await getUserByChatId(chatId);
  if (!user) {
    await bot.answerCallbackQuery(query.id, {
      text: "Аккаунт не привязан",
      show_alert: true,
    });
    return;
  }

  try {
    const db = await getDb();
    const task = await db.task.findUnique({
      where: { id: taskId },
      include: {
        column: { select: { name: true, workspaceId: true } },
        assignees: { select: { userId: true } },
      },
    });
    if (!task) {
      await bot.answerCallbackQuery(query.id, {
        text: "Задача не найдена",
        show_alert: true,
      });
      return;
    }

    const targetColumn = await db.column.findUnique({
      where: { id: columnId },
      select: { name: true },
    });
    if (!targetColumn) {
      await bot.answerCallbackQuery(query.id, {
        text: "Колонка не найдена",
        show_alert: true,
      });
      return;
    }

    // Get max position in target column
    const maxPos = await db.task.findFirst({
      where: { columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    await db.task.update({
      where: { id: taskId },
      data: { columnId, position: maxPos ? maxPos.position + 1 : 0 },
    });

    // Log move
    await db.columnMoveLog.create({
      data: {
        taskId,
        movedByUserId: user.id,
        fromColumnName: task.column.name,
        toColumnName: targetColumn.name,
      },
    });

    // Handle timer transitions
    const { handleColumnTransition } =
      await import("@/lib/services/timer.service");
    await handleColumnTransition(
      db,
      taskId,
      task.column.name,
      targetColumn.name,
    );

    await bot.answerCallbackQuery(query.id, { text: "✅ Перемещено" });
    if (messageId) await bot.deleteMessage(chatId, messageId);

    await bot.sendMessage(
      chatId,
      `✅ <i>${escapeHtml(task.title)}</i>\n${escapeHtml(task.column.name)} → <b>${escapeHtml(targetColumn.name)}</b>`,
      { parse_mode: "HTML" },
    );

    // Notify assignees
    const { notify } = await import("@/lib/services/notification.service");
    for (const a of task.assignees) {
      if (a.userId !== user.id) {
        void notify({
          type: "MOVED",
          recipientId: a.userId,
          actorId: user.id,
          taskId,
          workspaceId: task.column.workspaceId,
          extra: { fromColumn: task.column.name, toColumn: targetColumn.name },
        });
      }
    }
  } catch (error) {
    console.error("[Telegram bot] move error:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "Ошибка перемещения",
      show_alert: true,
    });
  }
}

// ─── Priority handlers ──────────────────────────────────────────────────────

async function handlePrioStart(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  taskId: string,
) {
  const priorities: { value: TaskPriority; label: string }[] = [
    { value: "NONE", label: "⚪ Без приоритета" },
    { value: "LOW", label: "🔵 Низкий" },
    { value: "MEDIUM", label: "🟡 Средний" },
    { value: "HIGH", label: "🟠 Высокий" },
    { value: "URGENT", label: "🔴 Срочный" },
  ];

  const keyboard: TelegramBot.InlineKeyboardButton[][] = priorities.map((p) => [
    { text: p.label, callback_data: `setprio:${taskId}:${p.value}` },
  ]);
  keyboard.push([{ text: "⬅️ Назад", callback_data: `backto:${taskId}` }]);

  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(chatId, "Выберите приоритет:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleSetPrio(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  payload: string,
  messageId?: number,
) {
  const pp = payload.split(":");
  const taskId = pp[0]!;
  const priority = pp[1]!;

  try {
    const db = await getDb();
    await db.task.update({
      where: { id: taskId },
      data: { priority: priority as TaskPriority },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ Приоритет изменён" });
    if (messageId) await bot.deleteMessage(chatId, messageId);
    await sendTaskCard(bot, chatId, taskId);
  } catch (error) {
    console.error("[Telegram bot] setprio error:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "Ошибка",
      show_alert: true,
    });
  }
}

// ─── Checklist handlers ─────────────────────────────────────────────────────

async function handleChecklistShow(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  taskId: string,
) {
  const db = await getDb();
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      title: true,
      checklistItems: { orderBy: { position: "asc" } },
    },
  });

  if (!task || task.checklistItems.length === 0) {
    await bot.answerCallbackQuery(query.id, { text: "Чек-лист пуст" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] =
    task.checklistItems.map((item) => [
      {
        text: `${item.checked ? "✅" : "⬜"} ${item.text.slice(0, 40)}`,
        callback_data: `toggle:${taskId}:${item.id}`,
      },
    ]);
  keyboard.push([{ text: "⬅️ Назад", callback_data: `backto:${taskId}` }]);

  const done = task.checklistItems.filter((i) => i.checked).length;
  const total = task.checklistItems.length;

  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(
    chatId,
    `☑️ <b>Чек-лист</b> (${done}/${total})\n<i>${escapeHtml(task.title)}</i>\n\nНажмите чтобы отметить/снять:`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } },
  );
}

async function handleToggleChecklist(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: string,
  payload: string,
  messageId?: number,
) {
  const cp = payload.split(":");
  const taskId = cp[0]!;
  const itemId = cp[1]!;

  try {
    const db = await getDb();
    const item = await db.checklistItem.findUnique({
      where: { id: itemId },
      select: { checked: true },
    });
    if (!item) {
      await bot.answerCallbackQuery(query.id, {
        text: "Пункт не найден",
        show_alert: true,
      });
      return;
    }

    await db.checklistItem.update({
      where: { id: itemId },
      data: { checked: !item.checked },
    });

    await bot.answerCallbackQuery(query.id, {
      text: !item.checked ? "✅ Отмечено" : "⬜ Снято",
    });

    // Refresh checklist view in place
    if (messageId) await bot.deleteMessage(chatId, messageId);

    // Re-show checklist
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { title: true, checklistItems: { orderBy: { position: "asc" } } },
    });

    if (task && task.checklistItems.length > 0) {
      const keyboard: TelegramBot.InlineKeyboardButton[][] =
        task.checklistItems.map((ci) => [
          {
            text: `${ci.checked ? "✅" : "⬜"} ${ci.text.slice(0, 40)}`,
            callback_data: `toggle:${taskId}:${ci.id}`,
          },
        ]);
      keyboard.push([
        { text: "⬅️ Назад к задаче", callback_data: `backto:${taskId}` },
      ]);

      const done = task.checklistItems.filter((i) => i.checked).length;
      const total = task.checklistItems.length;

      await bot.sendMessage(
        chatId,
        `☑️ <b>Чек-лист</b> (${done}/${total})\n<i>${escapeHtml(task.title)}</i>\n\nНажмите чтобы отметить/снять:`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } },
      );
    }
  } catch (error) {
    console.error("[Telegram bot] toggle error:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "Ошибка",
      show_alert: true,
    });
  }
}

// ─── New task handler ───────────────────────────────────────────────────────

async function handleNewTaskSubmit(
  bot: TelegramBot,
  chatId: string,
  workspaceId: string,
  columnId: string,
  title: string,
) {
  try {
    const db = await getDb();
    const user = await getUserByChatId(chatId);
    if (!user) {
      await bot.sendMessage(chatId, "Аккаунт не привязан.");
      return;
    }

    const maxPos = await db.task.findFirst({
      where: { columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const task = await db.task.create({
      data: {
        title,
        workspaceId,
        columnId,
        position: maxPos ? maxPos.position + 1 : 0,
        assignees: { create: [{ userId: user.id }] },
      },
    });

    await bot.sendMessage(
      chatId,
      `✅ Задача создана: <i>${escapeHtml(title)}</i>`,
      { parse_mode: "HTML" },
    );
    await sendTaskCard(bot, chatId, task.id);
  } catch (error) {
    console.error("[Telegram bot] new task error:", error);
    await bot.sendMessage(chatId, "Не удалось создать задачу.");
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

export function getTelegramBot(): TelegramBot | null {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN not set, bot disabled");
    return null;
  }

  if (globalForBot.__tgBotInitialized && globalForBot.__tgBot) {
    return globalForBot.__tgBot;
  }

  // Stop previous instance if exists (handles hot reload)
  if (globalForBot.__tgBot) {
    try {
      globalForBot.__tgBot.stopPolling({ cancel: true });
    } catch {
      // ignore
    }
    globalForBot.__tgBot = undefined;
  }

  // Wait a bit so Telegram API releases the previous polling session
  setTimeout(() => {
    const bot = new TelegramBot(token!, { polling: { interval: 1000 } });
    globalForBot.__tgBot = bot;
    globalForBot.__tgBotInitialized = true;
    setupHandlers(bot);
    bot.setMyCommands([
      { command: "tasks", description: "📋 Мои задачи" },
      { command: "my", description: "📊 Сводка" },
      { command: "help", description: "📖 Справка" },
      { command: "cancel", description: "❌ Отмена действия" },
    ]);
    console.log("[Telegram] Bot started in polling mode");
  }, 3000);

  // Mark as initialized immediately to prevent double init
  globalForBot.__tgBotInitialized = true;
  return null;
}
