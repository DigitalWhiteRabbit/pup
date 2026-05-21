import "server-only";

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Derive a 256-bit encryption key from ENCRYPTION_KEY or AUTH_SECRET.
 * SHA-256 normalises any-length secret into exactly 32 bytes.
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!raw) {
    throw new Error(
      "Missing ENCRYPTION_KEY or AUTH_SECRET — cannot encrypt/decrypt sensitive fields",
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Output format: base64( IV || authTag || ciphertext )
 */
export function encrypt(text: string): string {
  if (!text) return text;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Pack: [16-byte IV] [16-byte auth tag] [ciphertext]
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt an AES-256-GCM ciphertext produced by encrypt().
 *
 * Graceful migration: if decryption fails (e.g. value was stored before
 * encryption was enabled), return the original string so existing
 * unencrypted values keep working until the next write re-encrypts them.
 */
export function decrypt(encrypted: string): string {
  if (!encrypted) return encrypted;
  try {
    const buf = Buffer.from(encrypted, "base64");
    // Minimum valid payload: IV(16) + tag(16) + at least 1 byte ciphertext
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
      return encrypted; // too short to be a ciphertext — treat as plaintext
    }
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString("utf8") + decipher.final("utf8");
  } catch {
    // Decryption failed — value is likely still plaintext (pre-migration).
    // It will be re-encrypted on the next write cycle.
    return encrypted;
  }
}

// ── Sensitive field helpers ────────────────────────────────────────────

/** Fields in MktConfig that must be encrypted at rest. */
export const SENSITIVE_FIELDS = [
  "anthropicApiKey",
  "resendApiKey",
  "imapPass",
  "tgApiHash",
  "tgSession",
  "adminBotToken",
  "apifyToken",
  "youtubeApiKey",
] as const;

export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

/**
 * Decrypt all sensitive fields on a MktConfig row (read path).
 * Returns a shallow copy — the original object is not mutated.
 */
export function decryptConfig<T extends Record<string, unknown>>(row: T): T {
  const result = { ...row };
  for (const field of SENSITIVE_FIELDS) {
    const val = result[field];
    if (typeof val === "string" && val.length > 0) {
      (result as Record<string, unknown>)[field] = decrypt(val);
    }
  }
  return result;
}

/**
 * Encrypt all sensitive fields present in a partial update payload (write path).
 * Only encrypts fields that are actually in the data object.
 * Returns a shallow copy — the original object is not mutated.
 */
export function encryptConfigFields<T extends Record<string, unknown>>(
  data: T,
): T {
  const result = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (field in result) {
      const val = result[field];
      if (typeof val === "string" && val.length > 0) {
        (result as Record<string, unknown>)[field] = encrypt(val);
      }
    }
  }
  return result;
}
