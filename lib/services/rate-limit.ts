import "server-only";
import { NextResponse } from "next/server";
import { checkRateLimit } from "./chat/rate-limit.service";

/**
 * Reusable per-route rate limiter for authenticated API routes.
 *
 * Builds on the existing in-memory counter (chat/rate-limit.service) and adds
 * two independent keys per call: per-user-session AND per-IP. Either tripping
 * yields a 429 with Retry-After. Limits are deliberately generous — they exist
 * to cap cost/abuse on expensive (AI/transcription) and mutating endpoints, not
 * to throttle normal interactive use. GET/polling routes are NOT limited.
 *
 * In-memory + per-process (same as the SA / widget limiters). Good enough for
 * the single-node deployment; swap the counter for Redis if it ever scales out.
 */

/** Best-effort client IP from proxy headers (same derivation as resolve-auth). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

export type RateLimitOptions = {
  /** Logical bucket name, e.g. "ai:suggest" or "create:task". */
  scope: string;
  /** Per-user-session key (the authenticated user id). */
  userId?: string | null;
  /** Request — enables the per-IP key (recommended). */
  req?: Request;
  /** Max requests per window for the user key. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
  /** Also limit per IP (default true when req is given). */
  perIp?: boolean;
  /** Separate cap for the IP key (default = max * 10 — generous headroom so a
   *  whole office/VPN behind ONE NAT IP isn't collectively false-429'd; the
   *  per-user key is the real bound for authenticated routes). */
  ipMax?: number;
};

/**
 * Returns a 429 NextResponse if the caller is over any applicable limit, else
 * null. Call it right after authentication (so userId is known) and before the
 * expensive work.
 */
export function enforceRateLimit(opts: RateLimitOptions): NextResponse | null {
  const results: Array<{ allowed: boolean; resetAt: number }> = [];

  if (opts.userId) {
    results.push(
      checkRateLimit(`${opts.scope}:u:${opts.userId}`, opts.max, opts.windowMs),
    );
  }
  if ((opts.perIp ?? true) && opts.req) {
    const ip = clientIp(opts.req);
    results.push(
      checkRateLimit(
        `${opts.scope}:ip:${ip}`,
        opts.ipMax ?? opts.max * 10,
        opts.windowMs,
      ),
    );
  }

  const blocked = results.find((r) => !r.allowed);
  if (!blocked) return null;

  const retryAfter = Math.max(
    1,
    Math.ceil((blocked.resetAt - Date.now()) / 1000),
  );
  return NextResponse.json(
    {
      error: "Слишком много запросов. Попробуйте позже.",
      code: "RATE_LIMITED",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
