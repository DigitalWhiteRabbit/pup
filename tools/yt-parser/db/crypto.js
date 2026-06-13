// db/crypto.js — AES-256-GCM шифрование чувствительных полей.
// Порт lib/services/crypto.service.ts (PUP): тот же ключ и формат, чтобы
// шифротексты были взаимно совместимы. Формат: base64( IV(16) | tag(16) | ciphertext ).
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// Ключ из ENCRYPTION_KEY||AUTH_SECRET, нормализованный SHA-256 в 32 байта.
function getKey() {
  const raw = process.env.ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!raw) {
    throw new Error(
      "Missing ENCRYPTION_KEY or AUTH_SECRET — cannot encrypt/decrypt sensitive fields",
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(text) {
  if (!text) return text;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(text), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

// Graceful-decrypt: если расшифровка не удалась (значение было записано до
// включения шифрования) — возвращаем исходную строку (плавная миграция).
function decrypt(encrypted) {
  if (!encrypted) return encrypted;
  try {
    const buf = Buffer.from(encrypted, "base64");
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return encrypted;
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString("utf8") + decipher.final("utf8");
  } catch {
    return encrypted;
  }
}

module.exports = { encrypt, decrypt };
