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

function buildMessage(
  commitSha: string,
  commitMsg: string,
  author: string,
  stepIndex: StepIndex | "done" | "failed",
  failReason?: string,
): string {
  const shortSha = commitSha.slice(0, 7);

  if (stepIndex === "done") {
    const lines = [
      `<b>✅ Deploy завершён</b>`,
      ``,
      `Коммит: <code>${shortSha}</code>`,
      `${escapeHtml(commitMsg)}`,
      `Автор: ${escapeHtml(author)}`,
      ``,
      `${progressBar(5, 5)} 100%`,
      ``,
    ];
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
    ``,
  ];

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
    // "message is not modified" is fine
    if (!body.includes("message is not modified")) {
      console.error("[Deploy TG] editMessageText failed:", body);
      return false;
    }
  }
  return true;
}

/**
 * Called when GitHub push webhook arrives.
 * Sends the initial deploy message and saves it for later updates.
 */
export async function onDeployStarted(
  commitSha: string,
  commitMsg: string,
  author: string,
): Promise<void> {
  const chatId = process.env["DEPLOY_CHAT_ID"];
  if (!chatId) {
    console.warn("[Deploy] DEPLOY_CHAT_ID not set, skipping TG notification");
    return;
  }

  // Mark any previous building deploys as stale
  await db.deployMessage.updateMany({
    where: { status: "building" },
    data: { status: "failed" },
  });

  // Step 0: clone
  const text = buildMessage(commitSha, commitMsg, author, 0);
  const sent = await tgSend(chatId, text);
  if (!sent) return;

  await db.deployMessage.create({
    data: {
      commitSha,
      chatId,
      messageId: sent.message_id,
      status: "building",
    },
  });

  // Simulate progress steps with delays
  // Steps 1-3 are timed estimates since we can't hook into Coolify internals
  const delays = [8_000, 25_000, 15_000]; // deps, build, container

  for (let step = 1; step <= 3; step++) {
    setTimeout(
      async () => {
        try {
          // Check if deploy was already completed (new instance started)
          const record = await db.deployMessage.findFirst({
            where: { commitSha, status: "building" },
          });
          if (!record) return;

          const msg = buildMessage(
            commitSha,
            commitMsg,
            author,
            step as StepIndex,
          );
          await tgEdit(chatId, sent.message_id, msg);
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
 * Edits the deploy message to show completion.
 */
export async function onDeployCompleted(): Promise<void> {
  try {
    const record = await db.deployMessage.findFirst({
      where: { status: "building" },
      orderBy: { createdAt: "desc" },
    });

    if (!record) return;

    // We need commit info to build the final message
    // Try to get it from git
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

    const text = buildMessage(record.commitSha, commitMsg, author, "done");
    await tgEdit(record.chatId, record.messageId, text);

    await db.deployMessage.update({
      where: { id: record.id },
      data: { status: "done" },
    });

    console.log(
      `[Deploy] Marked deploy ${record.commitSha.slice(0, 7)} as done`,
    );
  } catch (e) {
    console.error("[Deploy] onDeployCompleted error:", e);
  }
}
