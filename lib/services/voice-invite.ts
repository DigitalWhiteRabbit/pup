/**
 * voice-invite.ts — stateless signed guest invite tokens for Voice rooms.
 *
 * P0 fix: the old invite endpoint generated a random token that was never
 * stored or verified, so guests could join ANY room with a self-minted UUID
 * (and bypass the private-room allow-list). We instead issue an HMAC-signed
 * token bound to (workspaceId, roomId) with an expiry — verifiable server-side
 * with NO DB storage (and therefore no schema migration).
 *
 * Token format: `base64url(payloadJSON).base64url(HMAC_SHA256(payload))`
 * payload = { w: workspaceId, r: roomId, exp: epoch-ms }
 * Key = SHA-256(AUTH_SECRET) (same secret family as crypto.service).
 */
import crypto from "crypto";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function signingKey(): Buffer {
  const raw = process.env.AUTH_SECRET || process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "AUTH_SECRET/ENCRYPTION_KEY missing — cannot sign/verify voice invites",
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function hmac(body: string): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(body)
    .digest("base64url");
}

/** Issue a signed invite token bound to a specific room+workspace. */
export function createVoiceInvite(
  workspaceId: string,
  roomId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const payload = { w: workspaceId, r: roomId, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${body}.${hmac(body)}`;
}

/**
 * Verify a guest invite token against the requested (workspaceId, roomId).
 * Returns true only for an untampered, unexpired token bound to this room.
 * Constant-time signature comparison; never throws on malformed input.
 */
export function verifyVoiceInvite(
  token: string | undefined | null,
  workspaceId: string,
  roomId: string,
): boolean {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return false;

  // Constant-time signature check.
  let expected: string;
  try {
    expected = hmac(body);
  } catch {
    return false;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // Decode + validate claims.
  let payload: { w?: unknown; r?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (payload.w !== workspaceId || payload.r !== roomId) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  return true;
}
