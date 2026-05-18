const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { stmts } = require("../db/database");

// ─── State ──────────────────────────────────────────────────────────

let state = {
  client: null,
  ready: false,
  loginInProgress: false,
  codeResolver: null,
  passwordResolver: null,
  loginError: null,
  username: null,
  myId: null,
};

let messageCallback = null;

function getStoredSession() {
  const row = stmts.getSetting.get("telegram_session");
  return row ? row.value : "";
}

function getApiCreds() {
  return {
    apiId: parseInt(process.env.TG_API_ID || "0", 10),
    apiHash: process.env.TG_API_HASH || "",
    phone: process.env.TG_PHONE || "",
  };
}

function isReady() {
  return state.ready;
}

function status() {
  return {
    ready: state.ready,
    loginInProgress: state.loginInProgress,
    waitingFor: state.codeResolver
      ? "code"
      : state.passwordResolver
        ? "password"
        : null,
    username: state.username,
    error: state.loginError,
    hasSession: !!getStoredSession(),
    hasCreds: !!(
      getApiCreds().apiId &&
      getApiCreds().apiHash &&
      getApiCreds().phone
    ),
  };
}

// ─── Auto-login from saved session ──────────────────────────────────

async function tryAutoLogin() {
  const session = getStoredSession();
  if (!session) return false;
  const { apiId, apiHash } = getApiCreds();
  if (!apiId || !apiHash) return false;

  try {
    state.client = new TelegramClient(
      new StringSession(session),
      apiId,
      apiHash,
      { connectionRetries: 3, useWSS: false },
    );
    await state.client.connect();
    if (await state.client.isUserAuthorized()) {
      state.ready = true;
      const me = await state.client.getMe();
      state.username = me.username || me.firstName || "unknown";
      state.myId = me.id?.toString();
      attachListener();
      console.log(`[tg] auto-login success as @${state.username}`);
      return true;
    }
  } catch (e) {
    console.error("[tg] auto-login failed:", e.message);
  }
  return false;
}

// ─── Interactive login ──────────────────────────────────────────────

async function startLogin() {
  if (state.loginInProgress)
    throw new Error("Login уже идёт. Введи код или дождись завершения.");
  if (state.ready) throw new Error("Уже залогинен");

  const { apiId, apiHash, phone } = getApiCreds();
  if (!apiId || !apiHash)
    throw new Error("TG_API_ID и TG_API_HASH не заданы в .env");
  if (!phone) throw new Error("TG_PHONE не задан в .env");

  state.loginInProgress = true;
  state.loginError = null;
  state.codeResolver = null;
  state.passwordResolver = null;

  state.client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: false,
  });

  // Запускаем login в фоне с deferred-promise resolvers
  state.client
    .start({
      phoneNumber: async () => phone,
      phoneCode: async () =>
        new Promise((resolve) => {
          state.codeResolver = resolve;
        }),
      password: async () =>
        new Promise((resolve) => {
          state.passwordResolver = resolve;
        }),
      onError: (err) => {
        state.loginError = err.message || String(err);
        console.error("[tg login error]", err);
      },
    })
    .then(async () => {
      state.ready = true;
      state.loginInProgress = false;
      const sessionStr = state.client.session.save();
      stmts.setSetting.run("telegram_session", sessionStr);
      try {
        const me = await state.client.getMe();
        state.username = me.username || me.firstName || "unknown";
        state.myId = me.id?.toString();
        attachListener();
        console.log(`[tg] login success as @${state.username}, session saved`);
      } catch (e) {
        console.error("[tg] failed to fetch me:", e.message);
      }
    })
    .catch((e) => {
      state.loginError = e.message;
      state.loginInProgress = false;
      state.ready = false;
      console.error("[tg] login failed:", e.message);
    });

  return { status: "sms_sent", message: "SMS-код отправлен на " + phone };
}

function provideCode(code) {
  if (!state.codeResolver) throw new Error("Сейчас код не запрашивается");
  state.codeResolver(code);
  state.codeResolver = null;
}

function providePassword(password) {
  if (!state.passwordResolver)
    throw new Error("Сейчас пароль не запрашивается");
  state.passwordResolver(password);
  state.passwordResolver = null;
}

async function logout() {
  if (state.client) {
    try {
      await state.client.disconnect();
    } catch {}
  }
  stmts.setSetting.run("telegram_session", "");
  state = {
    client: null,
    ready: false,
    loginInProgress: false,
    codeResolver: null,
    passwordResolver: null,
    loginError: null,
    username: null,
    myId: null,
  };
  console.log("[tg] logged out");
}

// ─── Sending ────────────────────────────────────────────────────────

async function sendMessage(usernameOrPhone, text) {
  if (!state.ready)
    throw new Error("Telegram client не готов. Залогинься в Настройках.");
  const target = String(usernameOrPhone).replace(/^@/, "").trim();
  if (!target) throw new Error("Пустой получатель");

  const result = await state.client.sendMessage(target, { message: text });
  return {
    messageId: result.id?.toString(),
    chatId: result.peerId?.userId?.toString() || target,
  };
}

// ─── Receiving ──────────────────────────────────────────────────────

function onMessage(cb) {
  messageCallback = cb;
}

function attachListener() {
  if (!state.client) return;
  state.client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;
      const sender = await msg.getSender();
      if (!sender) return;
      const senderUsername = sender.username || null;
      const senderId = sender.id?.toString();

      if (messageCallback) {
        await messageCallback({
          username: senderUsername,
          senderId,
          text: msg.message || "",
          messageId: msg.id?.toString(),
          chatId: msg.peerId?.userId?.toString() || senderId,
          date: new Date(msg.date * 1000).toISOString(),
        });
      }
    } catch (e) {
      console.error("[tg listener error]", e.message);
    }
  }, new NewMessage({}));
}

module.exports = {
  tryAutoLogin,
  startLogin,
  provideCode,
  providePassword,
  sendMessage,
  onMessage,
  status,
  isReady,
  logout,
};
