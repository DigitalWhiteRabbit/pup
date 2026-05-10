import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { checkRateLimit } from "@/lib/services/chat/rate-limit.service";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first request", () => {
    const result = checkRateLimit("test-key-1", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("allows up to max requests", () => {
    for (let i = 0; i < 4; i++) {
      const r = checkRateLimit("test-key-2", 5, 60000);
      expect(r.allowed).toBe(true);
    }
    // 5th request
    const last = checkRateLimit("test-key-2", 5, 60000);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it("blocks after max requests", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-key-3", 5, 60000);
    }
    // 6th request
    const blocked = checkRateLimit("test-key-3", 5, 60000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-key-4", 5, 60000);
    }

    // Advance past window
    vi.advanceTimersByTime(61000);

    const result = checkRateLimit("test-key-4", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("uses independent keys", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("key-a", 5, 60000);
    }
    // key-a is exhausted
    const blockedA = checkRateLimit("key-a", 5, 60000);
    expect(blockedA.allowed).toBe(false);

    // key-b should still be fresh
    const freshB = checkRateLimit("key-b", 5, 60000);
    expect(freshB.allowed).toBe(true);
  });
});
