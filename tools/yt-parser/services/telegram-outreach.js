const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { FloodWaitError } = require("telegram/errors");
const { stmts, db } = require("../db/database");
const { localDateKey } = require("../utils/dates");

// ─── Multi-account pool ─────────────────────────────────────────────
// Персистентные поля аккаунта (сессия, прокси, статус, лимиты, флуд) живут в
// таблице tg_account (default-БД). В памяти держим только «живое» состояние
// клиента: сам TelegramClient, готовность, резолверы интерактивного логина.
//
//   pool: Map<accountId, {
//     client, ready, loginInProgress, codeResolver, passwordResolver,
//     loginError, username, myId, listenerAttached
//   }>
const pool = new Map();

let messageCallback = null;
let rrIndex = 0; // round-robin курсор для pickAccount

// Ramp-up: день1=5, день2=10, … шаг +5/день до daily_cap аккаунта.
const RAMP_DAY1 = parseInt(process.env.TG_RAMP_DAY1 || "5", 10);
const RAMP_STEP = parseInt(process.env.TG_RAMP_STEP || "5", 10);

function todayKey() {
  return localDateKey();
}

function ensurePoolEntry(id) {
  if (!pool.has(id)) {
    pool.set(id, {
      client: null,
      ready: false,
      loginInProgress: false,
      codeResolver: null,
      passwordResolver: null,
      loginError: null,
      username: null,
      myId: null,
      listenerAttached: false,
    });
  }
  return pool.get(id);
}

function envApiCreds() {
  return {
    apiId: parseInt(process.env.TG_API_ID || "0", 10),
    apiHash: process.env.TG_API_HASH || "",
    phone: process.env.TG_PHONE || "",
  };
}

// ─── Proxy builder (SOCKS5 сейчас, заготовка под MTProxy) ───────────
// По мотивам tg-service build_proxy_kwargs. Возвращает proxy-опцию для
// TelegramClient ({ip, port, socksType,...}) либо null, если прокси не задан.
function buildProxyOpts(row) {
  if (!row || !row.proxy_host || !row.proxy_port) return null;
  const type = String(row.proxy_type || "socks5").toLowerCase();

  if (type === "mtproxy") {
    // Заготовка: MTProxy secret кладём в proxy_pass. Полная поддержка — позже.
    return {
      ip: row.proxy_host,
      port: Number(row.proxy_port),
      MTProxy: true,
      secret: row.proxy_pass || "",
    };
  }

  // socks5 (дефолт) / socks4
  const socksType = type === "socks4" ? 4 : 5;
  const opt = {
    ip: row.proxy_host,
    port: Number(row.proxy_port),
    socksType,
  };
  if (row.proxy_user) opt.username = row.proxy_user;
  if (row.proxy_pass) opt.password = row.proxy_pass;
  return opt;
}

function makeClient(row, session = "") {
  const apiId = row.api_id || envApiCreds().apiId;
  const apiHash = row.api_hash || envApiCreds().apiHash;
  const opts = { connectionRetries: 3, useWSS: false };
  const proxy = buildProxyOpts(row);
  if (proxy) {
    opts.proxy = proxy;
  } else {
    console.warn(
      `[tg][acc#${row.id}] прокси не задан — для прод-TG прокси обязателен (1 акк = 1 прокси)`,
    );
  }
  return new TelegramClient(new StringSession(session), apiId, apiHash, opts);
}

// ─── Health / limits ────────────────────────────────────────────────

function sentTodayOf(row) {
  return row.sent_today_date === todayKey() ? row.sent_today || 0 : 0;
}

function daysSince(iso) {
  if (!iso) return 0;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return 0;
  const startThen = new Date(
    then.getFullYear(),
    then.getMonth(),
    then.getDate(),
  ).getTime();
  const now = new Date();
  const startNow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return Math.max(0, Math.floor((startNow - startThen) / 86400000));
}

// Текущий дневной лимит аккаунта с учётом ramp-up по first_used_at.
function effectiveCap(row) {
  const cap = row.daily_cap || parseInt(process.env.DAILY_CAP_TG || "50", 10);
  if (!row.first_used_at) return Math.min(cap, RAMP_DAY1);
  const dayIndex = daysSince(row.first_used_at) + 1;
  return Math.min(cap, RAMP_DAY1 + (dayIndex - 1) * RAMP_STEP);
}

// Вернуть в active аккаунты, у которых истёк flood_until.
function recoverFlooded() {
  try {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT id FROM tg_account WHERE status = 'flood' AND (flood_until IS NULL OR flood_until < ?)`,
      )
      .all(now);
    for (const r of rows)
      stmts.setTgAccountStatus.run("active", new Date().toISOString(), r.id);
  } catch (e) {
    console.error("[tg] recoverFlooded:", e.message);
  }
}

// Список «здоровых» аккаунтов: active + залогинен + не во флуде + под лимитом.
function healthyAccounts() {
  recoverFlooded();
  const now = Date.now();
  const rows = stmts.listActiveTgAccounts.all();
  const out = [];
  for (const r of rows) {
    const st = pool.get(r.id);
    if (!st || !st.ready || !st.client) continue;
    if (r.flood_until && r.flood_until > now) continue;
    if (sentTodayOf(r) >= effectiveCap(r)) continue;
    out.push(r);
  }
  return out;
}

// Round-robin по здоровью среди active. Возвращает accountId или null.
function pickAccount() {
  const candidates = healthyAccounts();
  if (!candidates.length) return null;
  const row = candidates[rrIndex % candidates.length];
  rrIndex++;
  return row.id;
}

// Есть ли хотя бы один здоровый аккаунт (для подсветки доступности TG-канала).
function anyReadyUnderLimit() {
  return healthyAccounts().length > 0;
}

// ─── FloodWait detection ────────────────────────────────────────────
function floodSeconds(e) {
  if (!e) return null;
  if (e instanceof FloodWaitError && typeof e.seconds === "number")
    return e.seconds;
  const text = String(e.errorMessage || e.message || e.className || "");
  const m = text.match(/FLOOD_WAIT_(\d+)/);
  if (m) return parseInt(m[1], 10);
  if (typeof e.seconds === "number" && /flood/i.test(text)) return e.seconds;
  return null;
}

// ─── Listener (per-account, тегирует входящие account_id) ───────────
function onMessage(cb) {
  messageCallback = cb;
}

function attachListenerFor(id) {
  const st = pool.get(id);
  if (!st || !st.client || st.listenerAttached) return;
  st.client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;
      const sender = await msg.getSender();
      if (!sender) return;
      if (messageCallback) {
        await messageCallback({
          accountId: id,
          username: sender.username || null,
          senderId: sender.id?.toString(),
          text: msg.message || "",
          messageId: msg.id?.toString(),
          chatId: msg.peerId?.userId?.toString() || sender.id?.toString(),
          date: new Date(msg.date * 1000).toISOString(),
        });
      }
    } catch (e) {
      console.error(`[tg listener acc#${id}]`, e.message);
    }
  }, new NewMessage({}));
  st.listenerAttached = true;
}

// ─── Auto-login ─────────────────────────────────────────────────────

// Однократная миграция: если аккаунтов ещё нет, но в settings лежит
// telegram_session старого single-account режима — заводим из него tg_account,
// чтобы не потерять уже залогиненный прод-аккаунт.
function migrateLegacySession() {
  try {
    if (stmts.listTgAccounts.all().length > 0) return;
    const legacy = stmts.getSetting.get("telegram_session");
    const sess = legacy && legacy.value ? legacy.value : "";
    if (!sess) return; // мигрируем только реально залогиненную сессию
    const { apiId, apiHash, phone } = envApiCreds();
    const now = new Date().toISOString();
    const r = stmts.insertTgAccount.run({
      label: "legacy (env)",
      phone: phone || null,
      api_id: apiId || null,
      api_hash: apiHash || null,
      proxy_type: "socks5",
      proxy_host: null,
      proxy_port: null,
      proxy_user: null,
      proxy_pass: null,
      status: "active",
      daily_cap: parseInt(process.env.DAILY_CAP_TG || "50", 10),
      created_at: now,
      updated_at: now,
    });
    stmts.setTgAccountSession.run(sess, now, r.lastInsertRowid);
    console.log(
      `[tg] перенёс legacy-сессию из settings → tg_account#${r.lastInsertRowid}`,
    );
  } catch (e) {
    console.error("[tg] migrateLegacySession:", e.message);
  }
}

async function tryAutoLoginAll() {
  migrateLegacySession();
  const rows = stmts.listActiveTgAccounts.all();
  let any = false;
  for (const row of rows) {
    if (!row.session) continue;
    const { apiId, apiHash } = {
      apiId: row.api_id || envApiCreds().apiId,
      apiHash: row.api_hash || envApiCreds().apiHash,
    };
    if (!apiId || !apiHash) continue;
    try {
      const st = ensurePoolEntry(row.id);
      st.client = makeClient(row, row.session);
      await st.client.connect();
      if (await st.client.isUserAuthorized()) {
        st.ready = true;
        const me = await st.client.getMe();
        st.username = me.username || me.firstName || "unknown";
        st.myId = me.id?.toString();
        attachListenerFor(row.id);
        any = true;
        console.log(
          `[tg][acc#${row.id}] auto-login success as @${st.username}`,
        );
      } else {
        st.ready = false;
      }
    } catch (e) {
      console.error(`[tg][acc#${row.id}] auto-login failed:`, e.message);
    }
  }
  return any;
}

// ─── Per-account interactive login ──────────────────────────────────

async function loginAccount(id) {
  const row = stmts.getTgAccount.get(id);
  if (!row) throw new Error("account not found");
  const st = ensurePoolEntry(id);
  if (st.loginInProgress)
    throw new Error("Login уже идёт. Введи код или дождись завершения.");
  if (st.ready) throw new Error("Уже залогинен");

  const apiId = row.api_id || envApiCreds().apiId;
  const apiHash = row.api_hash || envApiCreds().apiHash;
  if (!apiId || !apiHash)
    throw new Error("api_id/api_hash не заданы (ни в аккаунте, ни в env)");
  const phone = row.phone || envApiCreds().phone;
  if (!phone) throw new Error("phone не задан у аккаунта");

  st.loginInProgress = true;
  st.loginError = null;
  st.codeResolver = null;
  st.passwordResolver = null;
  st.client = makeClient(row, "");

  st.client
    .start({
      phoneNumber: async () => phone,
      phoneCode: async () =>
        new Promise((resolve) => {
          st.codeResolver = resolve;
        }),
      password: async () =>
        new Promise((resolve) => {
          st.passwordResolver = resolve;
        }),
      onError: (err) => {
        st.loginError = err.message || String(err);
        console.error(`[tg login error acc#${id}]`, err);
      },
    })
    .then(async () => {
      st.ready = true;
      st.loginInProgress = false;
      const sessionStr = st.client.session.save();
      stmts.setTgAccountSession.run(sessionStr, new Date().toISOString(), id);
      try {
        const me = await st.client.getMe();
        st.username = me.username || me.firstName || "unknown";
        st.myId = me.id?.toString();
        attachListenerFor(id);
        console.log(
          `[tg][acc#${id}] login success as @${st.username}, session saved`,
        );
      } catch (e) {
        console.error(`[tg][acc#${id}] failed to fetch me:`, e.message);
      }
    })
    .catch((e) => {
      st.loginError = e.message;
      st.loginInProgress = false;
      st.ready = false;
      console.error(`[tg][acc#${id}] login failed:`, e.message);
    });

  return { status: "sms_sent", message: "SMS-код отправлен на " + phone };
}

function provideCodeFor(id, code) {
  const st = pool.get(id);
  if (!st || !st.codeResolver)
    throw new Error("Сейчас код не запрашивается для этого аккаунта");
  st.codeResolver(code);
  st.codeResolver = null;
}

function providePasswordFor(id, password) {
  const st = pool.get(id);
  if (!st || !st.passwordResolver)
    throw new Error("Сейчас пароль не запрашивается для этого аккаунта");
  st.passwordResolver(password);
  st.passwordResolver = null;
}

async function logoutAccount(id) {
  const st = pool.get(id);
  if (st && st.client) {
    try {
      await st.client.disconnect();
    } catch {}
  }
  pool.delete(id);
  stmts.setTgAccountSession.run("", new Date().toISOString(), id);
  console.log(`[tg][acc#${id}] logged out`);
}

// ─── Account CRUD (для API) ─────────────────────────────────────────

function createAccount(fields = {}) {
  const now = new Date().toISOString();
  const r = stmts.insertTgAccount.run({
    label: fields.label || null,
    phone: fields.phone || null,
    api_id: fields.api_id != null ? parseInt(fields.api_id, 10) : null,
    api_hash: fields.api_hash || null,
    proxy_type: fields.proxy_type || "socks5",
    proxy_host: fields.proxy_host || null,
    proxy_port:
      fields.proxy_port != null ? parseInt(fields.proxy_port, 10) : null,
    proxy_user: fields.proxy_user || null,
    proxy_pass: fields.proxy_pass || null,
    status: fields.status || "active",
    daily_cap:
      fields.daily_cap != null
        ? parseInt(fields.daily_cap, 10)
        : parseInt(process.env.DAILY_CAP_TG || "50", 10),
    created_at: now,
    updated_at: now,
  });
  return stmts.getTgAccount.get(r.lastInsertRowid);
}

// Принять прокси-строку формата host:port:user:pass и разложить по полям.
function parseProxyString(raw) {
  if (!raw) return {};
  const parts = String(raw).trim().split(":");
  if (parts.length < 2) return {};
  return {
    proxy_host: parts[0],
    proxy_port: parseInt(parts[1], 10) || null,
    proxy_user: parts[2] || null,
    proxy_pass: parts[3] || null,
  };
}

function updateAccount(id, fields = {}) {
  const row = stmts.getTgAccount.get(id);
  if (!row) throw new Error("account not found");
  const patch = { ...fields };
  if (fields.proxy_string !== undefined) {
    Object.assign(patch, parseProxyString(fields.proxy_string));
    delete patch.proxy_string;
  }
  stmts.updateTgAccountFields.run({
    id,
    label: patch.label ?? null,
    phone: patch.phone ?? null,
    api_id: patch.api_id != null ? parseInt(patch.api_id, 10) : null,
    api_hash: patch.api_hash ?? null,
    proxy_type: patch.proxy_type ?? null,
    proxy_host: patch.proxy_host ?? null,
    proxy_port:
      patch.proxy_port != null ? parseInt(patch.proxy_port, 10) : null,
    proxy_user: patch.proxy_user ?? null,
    proxy_pass: patch.proxy_pass ?? null,
    status: patch.status ?? null,
    daily_cap: patch.daily_cap != null ? parseInt(patch.daily_cap, 10) : null,
    updated_at: new Date().toISOString(),
  });
  return stmts.getTgAccount.get(id);
}

async function deleteAccount(id) {
  await logoutAccount(id).catch(() => {});
  stmts.deleteTgAccount.run(id);
}

// ─── Sending ────────────────────────────────────────────────────────

// Базовая отправка от конкретного аккаунта (без пейсинга — пейсинг в шаге 4).
async function _rawSendVia(accountId, usernameOrPhone, text) {
  const st = pool.get(accountId);
  if (!st || !st.ready || !st.client)
    throw new Error(`TG account #${accountId} не готов`);
  const target = String(usernameOrPhone).replace(/^@/, "").trim();
  if (!target) throw new Error("Пустой получатель");

  try {
    const result = await st.client.sendMessage(target, { message: text });
    stmts.recordTgAccountSend.run({
      id: accountId,
      date: todayKey(),
      now: new Date().toISOString(),
    });
    return {
      messageId: result.id?.toString(),
      chatId: result.peerId?.userId?.toString() || target,
      accountId,
    };
  } catch (e) {
    const sec = floodSeconds(e);
    if (sec != null) {
      const until = Date.now() + sec * 1000;
      stmts.setTgAccountFlood.run(
        until,
        "flood",
        new Date().toISOString(),
        accountId,
      );
      console.warn(
        `[tg][acc#${accountId}] FLOOD_WAIT ${sec}s → пауза до ${new Date(until).toISOString()}`,
      );
    }
    throw e;
  }
}

// ─── Pacing queue (анти-бан) ────────────────────────────────────────
// Все TG-отправки идут через одну общую очередь с человеческим джиттером
// между отправками (не пачкой). Джиттер настраивается env (дефолт 30–90с).
const PACING_MIN_MS = parseInt(process.env.TG_PACING_MIN_MS || "30000", 10);
const PACING_MAX_MS = parseInt(process.env.TG_PACING_MAX_MS || "90000", 10);
const sendQueue = [];
let queueRunning = false;
let lastSendAt = 0;

function pacingGapMs() {
  const lo = Math.min(PACING_MIN_MS, PACING_MAX_MS);
  const hi = Math.max(PACING_MIN_MS, PACING_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Поставить задачу-отправку в очередь; вернётся промис с её результатом.
function enqueueSend(task) {
  return new Promise((resolve, reject) => {
    sendQueue.push({ task, resolve, reject });
    runQueue();
  });
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (sendQueue.length) {
      const { task, resolve, reject } = sendQueue.shift();
      // Пауза-джиттер между отправками; перед первой (после простоя) — без паузы.
      if (lastSendAt) {
        const since = Date.now() - lastSendAt;
        const gap = pacingGapMs();
        if (since < gap) await sleep(gap - since);
      }
      try {
        const r = await task();
        resolve(r);
      } catch (e) {
        reject(e);
      } finally {
        lastSendAt = Date.now();
      }
    }
  } finally {
    queueRunning = false;
  }
}

function pacingStatus() {
  return {
    queued: sendQueue.length,
    running: queueRunning,
    last_send_at: lastSendAt ? new Date(lastSendAt).toISOString() : null,
    min_ms: PACING_MIN_MS,
    max_ms: PACING_MAX_MS,
  };
}

// Отправка от конкретного аккаунта — всегда через пейсинг-очередь.
async function sendMessageVia(accountId, usernameOrPhone, text) {
  return enqueueSend(() => _rawSendVia(accountId, usernameOrPhone, text));
}

// ─── Тест-сим (только для проверки логики пула без реального Telegram) ─
function __testInjectReady(id, ready = true) {
  const st = ensurePoolEntry(id);
  st.client = st.client || { __fake: true };
  st.ready = ready;
  st.username = st.username || `fake_${id}`;
  return st;
}

// ─── Status ─────────────────────────────────────────────────────────

function accountStatus(id) {
  const row = stmts.getTgAccount.get(id);
  if (!row) return null;
  const st = pool.get(id) || {};
  const now = Date.now();
  return {
    id: row.id,
    label: row.label,
    phone: row.phone,
    status: row.status,
    ready: !!st.ready,
    loginInProgress: !!st.loginInProgress,
    waitingFor: st.codeResolver
      ? "code"
      : st.passwordResolver
        ? "password"
        : null,
    username: st.username || null,
    error: st.loginError || null,
    hasSession: !!row.session,
    hasProxy: !!(row.proxy_host && row.proxy_port),
    proxy_type: row.proxy_type,
    sent_today: sentTodayOf(row),
    daily_cap: row.daily_cap,
    effective_cap: effectiveCap(row),
    flood_until:
      row.flood_until && row.flood_until > now ? row.flood_until : null,
    first_used_at: row.first_used_at,
  };
}

function listAccounts() {
  recoverFlooded();
  return stmts.listTgAccounts.all().map((r) => accountStatus(r.id));
}

// ─── Legacy single-account API (для текущего UI / routes до Фазы 2) ──
// Маппится на «первый» аккаунт пула. Фаза 2 переведёт UI на мульти-аккаунт.

function primaryAccountId() {
  const rows = stmts.listTgAccounts.all();
  return rows.length ? rows[0].id : null;
}

function isReady() {
  for (const st of pool.values()) if (st.ready) return true;
  return false;
}

function status() {
  const id = primaryAccountId();
  if (id) {
    const s = accountStatus(id);
    return {
      ready: s.ready,
      loginInProgress: s.loginInProgress,
      waitingFor: s.waitingFor,
      username: s.username,
      error: s.error,
      hasSession: s.hasSession,
      hasCreds: !!(envApiCreds().apiId && envApiCreds().apiHash),
      accounts: listAccounts(),
      pacing: pacingStatus(),
    };
  }
  const { apiId, apiHash, phone } = envApiCreds();
  return {
    ready: false,
    loginInProgress: false,
    waitingFor: null,
    username: null,
    error: null,
    hasSession: false,
    hasCreds: !!(apiId && apiHash && phone),
    accounts: [],
    pacing: pacingStatus(),
  };
}

async function tryAutoLogin() {
  return tryAutoLoginAll();
}

async function startLogin() {
  let id = primaryAccountId();
  if (!id) {
    const { phone, apiId, apiHash } = envApiCreds();
    if (!apiId || !apiHash)
      throw new Error("TG_API_ID и TG_API_HASH не заданы в .env");
    if (!phone) throw new Error("TG_PHONE не задан в .env");
    const acc = createAccount({
      label: "default (env)",
      phone,
      api_id: apiId,
      api_hash: apiHash,
    });
    id = acc.id;
  }
  return loginAccount(id);
}

// Легаси: код/пароль маршрутизируем тому аккаунту, что сейчас их ждёт.
function findAccountAwaiting(kind) {
  for (const [id, st] of pool.entries()) {
    if (kind === "code" && st.codeResolver) return id;
    if (kind === "password" && st.passwordResolver) return id;
  }
  return null;
}

function provideCode(code) {
  const id = findAccountAwaiting("code");
  if (!id) throw new Error("Сейчас код не запрашивается");
  provideCodeFor(id, code);
}

function providePassword(password) {
  const id = findAccountAwaiting("password");
  if (!id) throw new Error("Сейчас пароль не запрашивается");
  providePasswordFor(id, password);
}

async function logout() {
  const id = primaryAccountId();
  if (id) await logoutAccount(id);
}

// Легаси-отправка: выбираем здоровый аккаунт сами.
async function sendMessage(usernameOrPhone, text) {
  const id = pickAccount();
  if (id == null)
    throw new Error("Нет доступного TG-аккаунта (залогинен/под лимитом)");
  return sendMessageVia(id, usernameOrPhone, text);
}

module.exports = {
  // pool / multi-account
  listAccounts,
  accountStatus,
  createAccount,
  updateAccount,
  deleteAccount,
  loginAccount,
  provideCodeFor,
  providePasswordFor,
  logoutAccount,
  tryAutoLoginAll,
  pickAccount,
  sendMessageVia,
  anyReadyUnderLimit,
  // anti-ban helpers (exposed for tests/worker)
  effectiveCap,
  floodSeconds,
  buildProxyOpts,
  parseProxyString,
  pacingStatus,
  enqueueSend,
  recoverFlooded,
  __testInjectReady,
  // messaging
  onMessage,
  // legacy single-account API
  tryAutoLogin,
  startLogin,
  provideCode,
  providePassword,
  sendMessage,
  status,
  isReady,
  logout,
};
