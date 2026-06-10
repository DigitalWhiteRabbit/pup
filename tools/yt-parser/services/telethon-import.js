// Конвертация купленной Telethon-сессии (.session SQLite) в GramJS StringSession.
// Вход по телефону/коду для таких аккаунтов НЕ используем — берём готовый auth_key.
//
// Telethon .session → таблица sessions(dc_id, server_address, port, auth_key BLOB[256]).
// GramJS StringSession.save() = "1" + base64( dcId[1] + addrLen[2 BE] + addr + port[2 BE] + key[256] ).
//
// Секреты (auth_key) НИКОГДА не логируем — только длину/факт.

const Database = require("better-sqlite3");
const { StringSession } = require("telegram/sessions");
const { AuthKey } = require("telegram/crypto/AuthKey");

const AUTH_KEY_LEN = 256;

// Прочитать строку sessions из Telethon .session (better-sqlite3, readonly).
function readTelethonSession(sessionFilePath) {
  const db = new Database(sessionFilePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1",
      )
      .get();
    return row || null;
  } finally {
    db.close();
  }
}

// Главная функция: путь к .session → StringSession-строка ("1...").
async function telethonSessionToStringSession(sessionFilePath) {
  const row = readTelethonSession(sessionFilePath);
  if (!row) throw new Error("в .session нет строки в таблице sessions");

  const { dc_id, server_address, port, auth_key } = row;
  if (dc_id == null || !server_address || !port)
    throw new Error("в .session нет dc_id/server_address/port");

  const key = Buffer.isBuffer(auth_key)
    ? auth_key
    : auth_key
      ? Buffer.from(auth_key)
      : null;
  if (!key || key.length !== AUTH_KEY_LEN)
    throw new Error(
      `auth_key должен быть ${AUTH_KEY_LEN} байт, получено ${key ? key.length : 0}`,
    );

  const ss = new StringSession("");
  ss.setDC(dc_id | 0, String(server_address), port | 0);
  const ak = new AuthKey();
  await ak.setKey(key);
  ss.setAuthKey(ak);

  const saved = ss.save();
  if (!saved)
    throw new Error(
      "StringSession.save() вернул пустую строку (нет dc/addr/port/key)",
    );
  return saved;
}

// Разобрать GramJS StringSession обратно (для верификации round-trip).
// Возвращает { dcId, serverAddress, port, authKeyLen }.
async function inspectStringSession(stringSession) {
  const ss = new StringSession(stringSession);
  await ss.load();
  return {
    dcId: ss.dcId,
    serverAddress: ss.serverAddress,
    port: ss.port,
    authKeyLen:
      ss.authKey && ss.authKey.getKey() ? ss.authKey.getKey().length : 0,
  };
}

module.exports = {
  telethonSessionToStringSession,
  readTelethonSession,
  inspectStringSession,
  AUTH_KEY_LEN,
};
