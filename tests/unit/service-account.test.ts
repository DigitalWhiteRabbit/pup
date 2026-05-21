import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { checkServiceAccountRateLimit } from "@/lib/services/auth/service-account-rate-limit";

describe("Service Account Rate Limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first request", () => {
    const result = checkServiceAccountRateLimit("sa-test-1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999);
  });

  it("allows up to 1000 requests in 1 hour", () => {
    for (let i = 0; i < 999; i++) {
      checkServiceAccountRateLimit("sa-test-2");
    }
    const last = checkServiceAccountRateLimit("sa-test-2");
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it("blocks after 1000 requests", () => {
    for (let i = 0; i < 1000; i++) {
      checkServiceAccountRateLimit("sa-test-3");
    }
    const blocked = checkServiceAccountRateLimit("sa-test-3");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("resets after 1 hour", () => {
    for (let i = 0; i < 1000; i++) {
      checkServiceAccountRateLimit("sa-test-4");
    }

    // Advance past the 1-hour window
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);

    const result = checkServiceAccountRateLimit("sa-test-4");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999);
  });

  it("uses independent counters per account", () => {
    for (let i = 0; i < 1000; i++) {
      checkServiceAccountRateLimit("sa-account-a");
    }
    const blockedA = checkServiceAccountRateLimit("sa-account-a");
    expect(blockedA.allowed).toBe(false);

    const freshB = checkServiceAccountRateLimit("sa-account-b");
    expect(freshB.allowed).toBe(true);
  });
});
