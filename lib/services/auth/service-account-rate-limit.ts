/** In-memory rate limiter for service accounts — 1000 requests/hour per account */

const counters = new Map<string, { count: number; resetAt: number }>();
const MAX_REQUESTS = 1000;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function checkServiceAccountRateLimit(accountId: string): {
  allowed: boolean;
  retryAfter?: number;
  remaining: number;
} {
  const now = Date.now();
  const entry = counters.get(accountId);

  if (!entry || now > entry.resetAt) {
    counters.set(accountId, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS - 1 };
  }

  if (entry.count >= MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      remaining: 0,
    };
  }

  entry.count++;
  return { allowed: true, remaining: MAX_REQUESTS - entry.count };
}

// Periodic cleanup every 30 minutes
setInterval(
  () => {
    const now = Date.now();
    counters.forEach((entry, id) => {
      if (now > entry.resetAt) counters.delete(id);
    });
  },
  30 * 60 * 1000,
);
