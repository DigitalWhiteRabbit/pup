const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { FloodWaitError } = require("telegram/errors");
// Шаг 4b: tg_account полностью на store (MktTgAccount, секреты шифрованы).
// CRUD + движковый пул (load/pick/record/flood/session) — через prisma-store;
// sync hot-path (pickAccount/healthyAccounts/recoverFlooded) работает по in-memory
// Map (st.row), записи async через store. SQLite (db/database.js) здесь не нужен.
const store = require("../db/prisma-store");
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
      // Шаг 4b-1: кэш строки аккаунта (legacy-форма, session дешифрована) —
      // health-функции (pickAccount/healthyAccounts/recoverFlooded) читают ЕГО
      // (sync, in-memory), записи в БД идут async через store + мутируют st.row.
      row: null,
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
  // Параметры устройства из импортированной сессии — чтобы не выглядеть «новым
  // устройством» (Telegram сверяет device/app/lang при коннекте).
  if (row.device_model) opts.deviceModel = row.device_model;
  if (row.system_version) opts.systemVersion = row.system_version;
  if (row.app_version) opts.appVersion = row.app_version;
  if (row.lang_code) opts.langCode = row.lang_code;
  if (row.system_lang_code) opts.systemLangCode = row.system_lang_code;
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

// Вернуть в active аккаунты, у которых истёк flood_until. SYNC по in-memory Map:
// флипаем st.row в памяти + async fire-and-forget пишем статус в store.
function recoverFlooded() {
  const now = Date.now();
  for (const [id, st] of pool.entries()) {
    const r = st.row;
    if (!r || r.status !== "flood") continue;
    if (r.flood_until && r.flood_until >= now) continue;
    r.status = "active";
    r.flood_until = null;
    store
      .setTgAccountStatusById(id, "active", null)
      .catch((e) => console.error("[tg] recoverFlooded persist:", e.message));
  }
}

// Список «здоровых» аккаунтов: active + залогинен + не во флуде + под лимитом.
// SYNC по in-memory Map (st.row), без БД.
function healthyAccounts() {
  recoverFlooded();
  const now = Date.now();
  const out = [];
  for (const st of pool.values()) {
    const r = st.row;
    if (!r || !st.ready || !st.client) continue;
    if (r.status !== "active") continue;
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

// Catch-up: дозабрать последние ВХОДЯЩИЕ из конкретного чата через УЖЕ открытое
// соединение аккаунта и прогнать их через тот же messageCallback (как live-листенер).
// Нужно, когда сообщение пришло, пока callback не был подключён (реконнект не
// переигрывает уже полученные апдейты). Read-only, ничего не отправляет.
async function fetchRecentIncoming(accountId, peer, limit = 5) {
  const st = pool.get(accountId);
  if (!st || !st.ready || !st.client)
    throw new Error(`TG account #${accountId} не готов`);
  if (!messageCallback) throw new Error("listener callback не подключён");
  const target = String(peer).replace(/^@/, "").trim();
  const messages = await st.client.getMessages(target, { limit });
  let ingested = 0;
  // getMessages отдаёт от новых к старым — развернём, чтобы порядок был хронологический.
  for (const msg of [...messages].reverse()) {
    if (!msg || msg.out) continue; // только входящие
    let sender = null;
    try {
      sender = await msg.getSender();
    } catch {}
    await messageCallback({
      accountId,
      username: sender?.username || null,
      senderId: sender?.id?.toString(),
      text: msg.message || "",
      messageId: msg.id?.toString(),
      chatId:
        msg.peerId?.userId?.toString() || sender?.id?.toString() || target,
      date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
    });
    ingested++;
  }
  return ingested;
}

// ─── Auto-login ─────────────────────────────────────────────────────

async function tryAutoLoginAll() {
  const rows = await store.listAllActiveTgAccounts(); // секреты дешифрованы store
  let any = false;
  for (const row of rows) {
    const st = ensurePoolEntry(row.id);
    st.row = row; // кэш строки в пул (для sync health-функций)
    if (!row.session) continue;
    const { apiId, apiHash } = {
      apiId: row.api_id || envApiCreds().apiId,
      apiHash: row.api_hash || envApiCreds().apiHash,
    };
    if (!apiId || !apiHash) continue;
    try {
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
  const row = await store.getTgAccountById(id);
  if (!row) throw new Error("account not found");
  const st = ensurePoolEntry(id);
  st.row = row; // кэш строки в пул
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
      // session пишется ШИФРОВАННО (store сам шифрует через crypto.js)
      try {
        await store.updateTgAccountById(id, { session: sessionStr });
        if (st.row) st.row.session = sessionStr; // обновляем кэш (plaintext)
      } catch (e) {
        console.error(`[tg][acc#${id}] session persist:`, e.message);
      }
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
  await store
    .updateTgAccountById(id, { session: "" })
    .catch((e) => console.error(`[tg][acc#${id}] logout persist:`, e.message));
  console.log(`[tg][acc#${id}] logged out`);
}

// ─── Account CRUD (для API) ─────────────────────────────────────────

async function createAccount(wsId, fields = {}) {
  const { id } = await store.createTgAccount(wsId, {
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
  });
  return store.getTgAccountById(id);
}

// Импорт готовой Telethon-сессии: конвертим .session → StringSession и сохраняем
// аккаунт с device-параметрами из .json. Вход по телефону/коду не нужен.
// fields: { sessionFilePath, meta(json), proxy_string|proxy_*, label?, daily_cap? }
async function importAccount(wsId, fields = {}) {
  const { telethonSessionToStringSession } = require("./telethon-import");
  const meta = fields.meta || {};
  const sessionStr = await telethonSessionToStringSession(
    fields.sessionFilePath,
  );

  const proxy = fields.proxy_string
    ? parseProxyString(fields.proxy_string)
    : {
        proxy_host: fields.proxy_host || null,
        proxy_port: fields.proxy_port || null,
        proxy_user: fields.proxy_user || null,
        proxy_pass: fields.proxy_pass || null,
      };
  const hasProxy = !!(proxy.proxy_host && proxy.proxy_port);

  // label по умолчанию: "First Last (@username|phone)"
  const name = [meta.first_name, meta.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const handle = meta.username
    ? "@" + meta.username
    : meta.phone || fields.phone || "";
  const label =
    fields.label ||
    (name
      ? `${name}${handle ? " (" + handle + ")" : ""}`
      : handle || "imported");

  const { id } = await store.createTgAccount(wsId, {
    label,
    phone: meta.phone || fields.phone || null,
    api_id: meta.app_id != null ? parseInt(meta.app_id, 10) : null,
    api_hash: meta.app_hash || null,
    session: sessionStr, // store шифрует
    proxy_type: "socks5",
    proxy_host: proxy.proxy_host || null,
    proxy_port:
      proxy.proxy_port != null ? parseInt(proxy.proxy_port, 10) : null,
    proxy_user: proxy.proxy_user || null,
    proxy_pass: proxy.proxy_pass || null,
    // Без прокси работать с прод-TG нельзя — помечаем needs_proxy, иначе active.
    status: hasProxy ? "active" : "needs_proxy",
    daily_cap:
      fields.daily_cap != null
        ? parseInt(fields.daily_cap, 10)
        : parseInt(process.env.DAILY_CAP_TG || "50", 10),
    two_fa: meta.twoFA || meta.two_fa || null,
    user_id: meta.user_id != null ? String(meta.user_id) : null,
    device_model: meta.device || meta.device_model || null,
    system_version:
      meta.sdk || meta.systemVersion || meta.system_version || null,
    app_version: meta.app_version || null,
    lang_code: meta.lang_code || null,
    system_lang_code: meta.system_lang_code || null,
    source: "telethon-import",
  });
  return store.getTgAccountById(id);
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

async function updateAccount(wsId, id, fields = {}) {
  const row = await store.getTgAccount(wsId, id);
  if (!row) throw new Error("account not found");
  const patch = { ...fields };
  if (fields.proxy_string !== undefined) {
    Object.assign(patch, parseProxyString(fields.proxy_string));
    delete patch.proxy_string;
  }
  // Передаём в store только реально присланные поля (иначе COALESCE-семантики
  // нет — updateMany затрёт. Поэтому фильтруем undefined).
  const upd = {};
  const passthrough = [
    "label",
    "phone",
    "proxy_type",
    "proxy_host",
    "proxy_user",
    "proxy_pass",
    "api_hash",
    "status",
  ];
  for (const k of passthrough) if (patch[k] !== undefined) upd[k] = patch[k];
  if (patch.api_id !== undefined)
    upd.api_id = patch.api_id != null ? parseInt(patch.api_id, 10) : null;
  if (patch.proxy_port !== undefined)
    upd.proxy_port =
      patch.proxy_port != null ? parseInt(patch.proxy_port, 10) : null;
  if (patch.daily_cap !== undefined)
    upd.daily_cap =
      patch.daily_cap != null ? parseInt(patch.daily_cap, 10) : null;
  await store.updateTgAccount(wsId, id, upd);
  return store.getTgAccountById(id);
}

async function deleteAccount(wsId, id) {
  await logoutAccount(id).catch(() => {});
  await store.deleteTgAccount(wsId, id);
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
    const dateKey = todayKey();
    const nowIso = new Date().toISOString();
    // Учёт отправки → store (async) + мутируем кэш st.row для sync health-логики.
    await store
      .recordTgAccountSend(accountId, dateKey, nowIso)
      .catch((e) => console.error("[tg] recordSend persist:", e.message));
    if (st.row) {
      st.row.sent_today =
        st.row.sent_today_date === dateKey ? (st.row.sent_today || 0) + 1 : 1;
      st.row.sent_today_date = dateKey;
      st.row.last_sent_at = nowIso;
      st.row.first_used_at = st.row.first_used_at || nowIso;
    }
    return {
      messageId: result.id?.toString(),
      chatId: result.peerId?.userId?.toString() || target,
      accountId,
    };
  } catch (e) {
    const sec = floodSeconds(e);
    if (sec != null) {
      const until = Date.now() + sec * 1000;
      // Флуд → store (async) + кэш st.row (для sync healthyAccounts/recoverFlooded).
      await store
        .setTgAccountStatusById(accountId, "flood", until)
        .catch((err) => console.error("[tg] flood persist:", err.message));
      if (st.row) {
        st.row.status = "flood";
        st.row.flood_until = until;
      }
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

// Тест-хук 4b-1: загрузить строку аккаунта в пул без GramJS-коннекта.
// row — legacy-форма (как из store), fakeClient — мок client.sendMessage.
function __testLoadRow(row, { ready = true, fakeClient = null } = {}) {
  const st = ensurePoolEntry(row.id);
  st.row = row;
  st.ready = ready;
  st.client = fakeClient || { __fake: true };
  st.username = st.username || `fake_${row.id}`;
  return st;
}

// ─── Status ─────────────────────────────────────────────────────────

async function accountStatus(id) {
  const row = await store.getTgAccountById(id);
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
    // Несекретные метаданные импорта (для UI). Секреты (session/api_hash/two_fa)
    // НЕ отдаём.
    source: row.source || null,
    device_model: row.device_model || null,
    has_2fa: !!row.two_fa,
  };
}

// listAccounts(wsId) — ws-scoped (UI per-workspace). Аккаунты из store.
async function listAccounts(wsId) {
  recoverFlooded();
  const rows = await store.listTgAccounts(wsId);
  return Promise.all(rows.map((r) => accountStatus(r.id)));
}

// ─── Legacy single-account API (для текущего UI / routes до Фазы 2) ──
// Маппится на «первый» аккаунт пула. Фаза 2 переведёт UI на мульти-аккаунт.

async function primaryAccountId() {
  const rows = await store.listAllActiveTgAccounts();
  return rows.length ? rows[0].id : null;
}

function isReady() {
  for (const st of pool.values()) if (st.ready) return true;
  return false;
}

// status(wsId) — ws-scoped (UI per-workspace). accounts/primary — из store.
async function status(wsId) {
  const accounts = await listAccounts(wsId);
  const { apiId, apiHash, phone } = envApiCreds();
  const primary = accounts[0] || null;
  if (primary) {
    return {
      ready: primary.ready,
      loginInProgress: primary.loginInProgress,
      waitingFor: primary.waitingFor,
      username: primary.username,
      error: primary.error,
      hasSession: primary.hasSession,
      hasCreds: !!(apiId && apiHash),
      accounts,
      pacing: pacingStatus(),
    };
  }
  return {
    ready: false,
    loginInProgress: false,
    waitingFor: null,
    username: null,
    error: null,
    hasSession: false,
    hasCreds: !!(apiId && apiHash && phone),
    accounts,
    pacing: pacingStatus(),
  };
}

async function tryAutoLogin() {
  return tryAutoLoginAll();
}

async function startLogin() {
  // Легаси single-account env-login (движок на store, 4b). Аккаунт создаём через
  // store; воркспейс — из env (YT_DEFAULT_WORKSPACE_CUID), т.к. legacy-путь без ws.
  let id = await primaryAccountId();
  if (!id) {
    const { phone, apiId, apiHash } = envApiCreds();
    if (!apiId || !apiHash)
      throw new Error("TG_API_ID и TG_API_HASH не заданы в .env");
    if (!phone) throw new Error("TG_PHONE не задан в .env");
    const wsId = process.env.YT_DEFAULT_WORKSPACE_CUID;
    if (!wsId)
      throw new Error(
        "YT_DEFAULT_WORKSPACE_CUID не задан — некуда создать аккаунт",
      );
    const acc = await createAccount(wsId, {
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
  const id = await primaryAccountId();
  if (id) await logoutAccount(id);
}

// Легаси-отправка: выбираем здоровый аккаунт сами.
async function sendMessage(usernameOrPhone, text) {
  const id = pickAccount();
  if (id == null)
    throw new Error("Нет доступного TG-аккаунта (залогинен/под лимитом)");
  return sendMessageVia(id, usernameOrPhone, text);
}

// ─── Хелпер для операций с профилем аккаунта ────────────────────────
// Предоставляет подключённый client для произвольного fn(client).
// Использует пул, если аккаунт уже залогинен, иначе создаёт временный клиент.
// NO_PROXY guard: запрещает работу без прокси (реальный IP).
async function withAccountClient(rowOrId, fn) {
  // account-profile передаёт уже загруженный row (с расшифрованной session);
  // id-ветка (ws-agnostic, глобальный cuid) — через store.
  const row =
    typeof rowOrId === "object" && rowOrId !== null
      ? rowOrId
      : await store.getTgAccountById(rowOrId);
  if (!row)
    throw Object.assign(new Error("Account not found"), { status: 404 });

  if (!buildProxyOpts(row)) {
    throw Object.assign(
      new Error("У аккаунта нет proxy — операция через реальный IP запрещена"),
      { status: 403 },
    );
  }

  // Reuse pool client if already ready
  const st = pool.get(row.id);
  if (st && st.ready && st.client) {
    return fn(st.client);
  }

  // Temporary client for one-shot profile operations
  const client = makeClient(row, row.session || "");
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

module.exports = {
  // pool / multi-account
  listAccounts,
  accountStatus,
  createAccount,
  importAccount,
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
  fetchRecentIncoming,
  __testInjectReady,
  __testLoadRow,
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
  // profile operations
  withAccountClient,
};
