#!/usr/bin/env node
/*
 * Standalone deploy-progress updater, invoked by deploy.sh at each real stage.
 *
 * Why this exists: the live progress bar used to be driven by a setInterval
 * inside the pup Next.js process (lib/services/telegram/deploy.ts). But
 * deploy.sh runs `pm2 stop pup` before the build, which kills that process —
 * so the bar froze at the first step and only jumped to "done" when pup
 * restarted. deploy.sh is the only thing alive for the whole deploy, so it
 * must drive the progress.
 *
 * Data handoff: pup's onDeployStarted writes /tmp/pup-deploy.json with the
 * commit info + recipients (chatId + messageId per admin). This script reads
 * it and edits each Telegram message. No DB/build needed — plain Node stdlib.
 *
 * IMPORTANT: the message format below must stay in sync with buildMessage() in
 * lib/services/telegram/deploy.ts (used for the initial message and the final
 * "done"/"failed" states). Steps array and rendering are duplicated on purpose
 * to keep this script dependency-free.
 *
 * Usage: node deploy-progress.js <stepIndex>   (1=deps, 2=build, 3=container, 4=healthcheck)
 * Exits 0 on any problem (missing file/token) so it never breaks a deploy.
 */

const fs = require("fs");
const https = require("https");

const STATE_FILE = "/tmp/pup-deploy.json";
const STEPS = [
  "Клонирование",
  "Установка зависимостей",
  "Сборка проекта",
  "Запуск контейнера",
  "Healthcheck",
];

function progressBar(done, total) {
  const filled = Math.round((done / total) * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatElapsed(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}м ${sec}с` : `${sec}с`;
}

function buildMessage(commitSha, commitMsg, author, stepIndex, startedAtMs) {
  const shortSha = String(commitSha).slice(0, 7);
  const elapsed = startedAtMs ? formatElapsed(Date.now() - startedAtMs) : null;
  const pct = Math.round(((stepIndex + 1) / STEPS.length) * 100);

  const lines = [
    `<b>🚀 Deploy in progress</b>`,
    ``,
    `Коммит: <code>${shortSha}</code>`,
    `${escapeHtml(commitMsg)}`,
    `Автор: ${escapeHtml(author)}`,
    ``,
    `${progressBar(stepIndex + 1, STEPS.length)} ${pct}%`,
  ];
  if (elapsed) lines.push(`⏱ ${elapsed}`);
  lines.push(``);

  for (let i = 0; i < STEPS.length; i++) {
    if (i < stepIndex) lines.push(`✅ ${STEPS[i]}`);
    else if (i === stepIndex) lines.push(`⏳ ${STEPS[i]}...`);
    else lines.push(`⬜ ${STEPS[i]}`);
  }
  return lines.join("\n");
}

function editMessage(token, chatId, messageId, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/editMessageText`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (
            res.statusCode !== 200 &&
            !body.includes("message is not modified")
          ) {
            console.error(
              `[deploy-progress] edit failed (${res.statusCode}): ${body}`,
            );
          }
          resolve();
        });
      },
    );
    req.on("error", (e) => {
      console.error(`[deploy-progress] request error: ${e.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const stepIndex = parseInt(process.argv[2], 10);
  if (Number.isNaN(stepIndex) || stepIndex < 0 || stepIndex >= STEPS.length) {
    console.error(`[deploy-progress] bad step "${process.argv[2]}", skip`);
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    console.error("[deploy-progress] no state file, skip");
    return;
  }

  const startedAtMs = state.startedAt
    ? Date.parse(state.startedAt)
    : Date.now();
  const text = buildMessage(
    state.commitSha || "",
    state.commitMsg || "—",
    state.author || "—",
    stepIndex,
    startedAtMs,
  );

  // Dry-run for local testing: print the rendered message, don't call Telegram.
  if (process.env.DEPLOY_PROGRESS_DRYRUN === "1") {
    console.log(text);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[deploy-progress] no TELEGRAM_BOT_TOKEN, skip");
    return;
  }

  for (const r of state.recipients || []) {
    await editMessage(token, r.chatId, r.messageId, text);
  }
}

main();
