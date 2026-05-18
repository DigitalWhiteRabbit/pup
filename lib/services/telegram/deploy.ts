import "server-only";

import { db } from "@/lib/db";

const STEPS = [
  { key: "clone", label: "Клонирование" },
  { key: "deps", label: "Установка зависимостей" },
  { key: "build", label: "Сборка проекта" },
  { key: "container", label: "Запуск контейнера" },
  { key: "healthcheck", label: "Healthcheck" },
] as const;

type StepIndex = 0 | 1 | 2 | 3 | 4;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function progressBar(done: number, total: number): string {
  const filled = Math.round((done / total) * 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}м ${sec}с`;
  return `${sec}с`;
}

function buildMessage(
  commitSha: string,
  commitMsg: string,
  author: string,
  stepIndex: StepIndex | "done" | "failed",
  startedAt?: Date,
  failReason?: string,
): string {
  const shortSha = commitSha.slice(0, 7);
  const elapsed = startedAt
    ? formatElapsed(Date.now() - startedAt.getTime())
    : null;

  if (stepIndex === "done") {
    const lines = [
      `<b>✅ Deploy завершён</b>`,
      ``,
      `Коммит: <code>${shortSha}</code>`,
      `${escapeHtml(commitMsg)}`,
      `Автор: ${escapeHtml(author)}`,
      ``,
      `${progressBar(5, 5)} 100%`,
    ];
    if (elapsed) lines.push(`⏱ Время деплоя: <b>${elapsed}</b>`);
    lines.push(``);
    for (const step of STEPS) {
      lines.push(`✅ ${step.label}`);
    }
    return lines.join("\n");
  }

  if (stepIndex === "failed") {
    const lines = [
      `<b>❌ Deploy провален</b>`,
      ``,
      `Коммит: <code>${shortSha}</code>`,
      `${escapeHtml(commitMsg)}`,
      `Автор: ${escapeHtml(author)}`,
      ``,
    ];
    if (elapsed) lines.push(`⏱ ${elapsed}`);
    if (failReason) {
      lines.push(`Ошибка: ${escapeHtml(failReason)}`);
    }
    return lines.join("\n");
  }

  const idx = stepIndex as number;
  const pct = Math.round(((idx + 1) / STEPS.length) * 100);

  const lines = [
    `<b>🚀 Deploy in progress</b>`,
    ``,
    `Коммит: <code>${shortSha}</code>`,
    `${escapeHtml(commitMsg)}`,
    `Автор: ${escapeHtml(author)}`,
    ``,
    `${progressBar(idx + 1, STEPS.length)} ${pct}%`,
  ];
  if (elapsed) lines.push(`⏱ ${elapsed}`);
  lines.push(``);

  for (let i = 0; i < STEPS.length; i++) {
    if (i < idx) {
      lines.push(`✅ ${STEPS[i]!.label}`);
    } else if (i === idx) {
      lines.push(`⏳ ${STEPS[i]!.label}...`);
    } else {
      lines.push(`⬜ ${STEPS[i]!.label}`);
    }
  }

  return lines.join("\n");
}

async function tgSend(
  chatId: string,
  text: string,
): Promise<{ message_id: number } | null> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return null;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!res.ok) {
    console.error("[Deploy TG] sendMessage failed:", await res.text());
    return null;
  }

  const data = (await res.json()) as { result: { message_id: number } };
  return { message_id: data.result.message_id };
}

async function tgEdit(
  chatId: string,
  messageId: number,
  text: string,
): Promise<boolean> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return false;

  const res = await fetch(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    if (!body.includes("message is not modified")) {
      console.error("[Deploy TG] editMessageText failed:", body);
      return false;
    }
  }
  return true;
}

/** Get all admin users who have Telegram connected and deploy notifications on */
async function getDeployRecipients(): Promise<
  Array<{ id: string; telegramChatId: string }>
> {
  const users = await db.user.findMany({
    where: {
      role: "ADMIN",
      tgNotifyDeploy: true,
      telegramChatId: { not: null },
    },
    select: { id: true, telegramChatId: true },
  });

  return users.filter(
    (u): u is { id: string; telegramChatId: string } =>
      u.telegramChatId !== null,
  );
}

/**
 * Called when GitHub push webhook arrives.
 * Sends the initial deploy message to all admins with deploy notifications enabled.
 */
export async function onDeployStarted(
  commitSha: string,
  commitMsg: string,
  author: string,
): Promise<void> {
  const recipients = await getDeployRecipients();
  if (recipients.length === 0) {
    console.warn("[Deploy] No admins with deploy notifications enabled");
    return;
  }

  // Mark any previous building deploys as stale
  await db.deployMessage.updateMany({
    where: { status: "building" },
    data: { status: "failed" },
  });

  // Send to each recipient
  const startedAt = new Date();
  const text = buildMessage(commitSha, commitMsg, author, 0, startedAt);

  for (const recipient of recipients) {
    const sent = await tgSend(recipient.telegramChatId, text);
    if (!sent) continue;

    await db.deployMessage.create({
      data: {
        commitSha,
        chatId: recipient.telegramChatId,
        messageId: sent.message_id,
        status: "building",
      },
    });
  }

  // Simulate progress steps with delays
  const delays = [8_000, 25_000, 15_000]; // deps, build, container

  for (let step = 1; step <= 3; step++) {
    setTimeout(
      async () => {
        try {
          const records = await db.deployMessage.findMany({
            where: { commitSha, status: "building" },
          });
          if (records.length === 0) return;

          const msg = buildMessage(
            commitSha,
            commitMsg,
            author,
            step as StepIndex,
            records[0]!.createdAt,
          );

          for (const record of records) {
            await tgEdit(record.chatId, record.messageId, msg);
          }
        } catch (e) {
          console.error("[Deploy TG] progress update error:", e);
        }
      },
      delays.slice(0, step).reduce((a, b) => a + b, 0),
    );
  }
}

/**
 * Called when the new application instance starts up.
 * Edits all deploy messages to show completion.
 */
export async function onDeployCompleted(): Promise<void> {
  try {
    const records = await db.deployMessage.findMany({
      where: { status: "building" },
    });

    if (records.length === 0) return;

    let commitMsg = "";
    let author = "";
    try {
      const { execSync } = await import("child_process");
      commitMsg = execSync("git log -1 --pretty=%s 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
      author = execSync("git log -1 --pretty=%an 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
    } catch {
      commitMsg = "—";
      author = "—";
    }

    for (const record of records) {
      const text = buildMessage(
        record.commitSha,
        commitMsg,
        author,
        "done",
        record.createdAt,
      );
      await tgEdit(record.chatId, record.messageId, text);
    }

    await db.deployMessage.updateMany({
      where: { status: "building" },
      data: { status: "done" },
    });

    const sha = records[0]?.commitSha.slice(0, 7) ?? "?";
    console.log(
      `[Deploy] Marked deploy ${sha} as done for ${records.length} recipient(s)`,
    );
  } catch (e) {
    console.error("[Deploy] onDeployCompleted error:", e);
  }
}
