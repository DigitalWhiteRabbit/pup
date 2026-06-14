import { describe, it, expect, vi } from "vitest";

// Reusable HTTP rate limiter (P1-A): per-user-session + per-IP, 429 + Retry-After.
// Distinct `scope` per test isolates the shared in-memory counter.

vi.mock("server-only", () => ({}));

import { enforceRateLimit, clientIp } from "@/lib/services/rate-limit";

const ipReq = (ip: string) =>
  new Request("http://t", { headers: { "x-forwarded-for": ip } });

describe("enforceRateLimit — per-user limit", () => {
  it("allows up to max, then 429 with Retry-After", () => {
    const o = {
      scope: "t:a",
      userId: "u1",
      max: 3,
      windowMs: 60_000,
      perIp: false,
    };
    expect(enforceRateLimit(o)).toBeNull(); // 1
    expect(enforceRateLimit(o)).toBeNull(); // 2
    expect(enforceRateLimit(o)).toBeNull(); // 3
    const blocked = enforceRateLimit(o); // 4 → over
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked?.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("normal frequency (well under limit) never blocks", () => {
    const o = {
      scope: "t:freq",
      userId: "u1",
      max: 200,
      windowMs: 60_000,
      perIp: false,
    };
    for (let i = 0; i < 50; i++) expect(enforceRateLimit(o)).toBeNull();
  });

  it("two different users are independent", () => {
    const base = { scope: "t:b", max: 2, windowMs: 60_000, perIp: false };
    enforceRateLimit({ ...base, userId: "a" });
    enforceRateLimit({ ...base, userId: "a" });
    expect(enforceRateLimit({ ...base, userId: "a" })?.status).toBe(429);
    expect(enforceRateLimit({ ...base, userId: "b" })).toBeNull();
  });
});

describe("enforceRateLimit — per-IP limit", () => {
  it("IP cap trips across different users behind one IP", () => {
    const r = ipReq("9.9.9.9");
    const base = {
      scope: "t:c",
      req: r,
      max: 1000,
      windowMs: 60_000,
      ipMax: 2,
    };
    expect(enforceRateLimit({ ...base, userId: "u0" })).toBeNull();
    expect(enforceRateLimit({ ...base, userId: "u1" })).toBeNull();
    expect(enforceRateLimit({ ...base, userId: "u2" })?.status).toBe(429);
  });

  it("different IPs are independent", () => {
    const base = { scope: "t:d", max: 1000, windowMs: 60_000, ipMax: 1 };
    expect(
      enforceRateLimit({ ...base, userId: "x", req: ipReq("1.1.1.1") }),
    ).toBeNull();
    expect(
      enforceRateLimit({ ...base, userId: "x", req: ipReq("1.1.1.1") })?.status,
    ).toBe(429);
    expect(
      enforceRateLimit({ ...base, userId: "x", req: ipReq("2.2.2.2") }),
    ).toBeNull();
  });
});

describe("clientIp", () => {
  it("takes first x-forwarded-for entry", () => {
    expect(clientIp(ipReq("5.5.5.5, 6.6.6.6"))).toBe("5.5.5.5");
  });
  it("falls back to x-real-ip then unknown", () => {
    expect(
      clientIp(
        new Request("http://t", { headers: { "x-real-ip": "7.7.7.7" } }),
      ),
    ).toBe("7.7.7.7");
    expect(clientIp(new Request("http://t"))).toBe("unknown");
  });
});
