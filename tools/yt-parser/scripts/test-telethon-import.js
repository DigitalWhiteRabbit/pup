#!/usr/bin/env node
// Round-trip тест конвертации Telethon .session → GramJS StringSession.
// Секреты (auth_key) НЕ печатаются — только длина/факт совпадения.
// Запуск: node scripts/test-telethon-import.js
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  telethonSessionToStringSession,
  inspectStringSession,
} = require("../services/telethon-import");
const { StringSession } = require("telegram/sessions");

let failed = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (!cond) failed++;
};

(async () => {
  const p = path.join(
    require("os").tmpdir(),
    "synthetic-" + Date.now() + ".session",
  );
  const db = new Database(p);
  db.exec(
    "CREATE TABLE sessions (dc_id integer primary key, server_address text, port integer, auth_key blob, takeout_id integer)",
  );
  const key = crypto.randomBytes(256);
  const DC = 2,
    IP = "149.154.167.51",
    PORT = 443;
  db.prepare(
    "INSERT INTO sessions (dc_id, server_address, port, auth_key, takeout_id) VALUES (?,?,?,?,?)",
  ).run(DC, IP, PORT, key, null);
  db.close();

  const s = await telethonSessionToStringSession(p);
  check("StringSession непустая", !!s);
  check("начинается с версии '1'", s[0] === "1");

  const info = await inspectStringSession(s);
  check(`round-trip dc_id (${info.dcId}=${DC})`, info.dcId === DC);
  check(`round-trip ip (${info.serverAddress})`, info.serverAddress === IP);
  check(`round-trip port (${info.port})`, info.port === PORT);
  check(`round-trip auth_key 256 байт`, info.authKeyLen === 256);

  const ss = new StringSession(s);
  await ss.load();
  check(
    "auth_key байт-в-байт совпадает",
    Buffer.compare(ss.authKey.getKey(), key) === 0,
  );

  // negative: неверная длина ключа
  const p2 = path.join(
    require("os").tmpdir(),
    "bad-" + Date.now() + ".session",
  );
  const db2 = new Database(p2);
  db2.exec(
    "CREATE TABLE sessions (dc_id integer, server_address text, port integer, auth_key blob)",
  );
  db2
    .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
    .run(2, IP, PORT, crypto.randomBytes(100));
  db2.close();
  let threw = false;
  try {
    await telethonSessionToStringSession(p2);
  } catch (e) {
    threw = /256/.test(e.message);
  }
  check("кривой auth_key → ошибка", threw);

  // реальный файл, если положен в tmp/
  const real = path.join(__dirname, "..", "tmp", "573009563951.session");
  if (fs.existsSync(real)) {
    const ri = await inspectStringSession(
      await telethonSessionToStringSession(real),
    );
    console.log(
      `  [real] dc=${ri.dcId} ip=${ri.serverAddress} port=${ri.port} keyLen=${ri.authKeyLen}`,
    );
    check("real: auth_key 256 байт", ri.authKeyLen === 256);
  } else {
    console.log("  [real] tmp/573009563951.session не найден — пропуск (ок)");
  }

  fs.rmSync(p, { force: true });
  fs.rmSync(p2, { force: true });
  console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
