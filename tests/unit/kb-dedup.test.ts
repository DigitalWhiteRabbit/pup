import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  normalizeUrl,
  computeContentHash,
} from "@/lib/services/kb/dedup.service";

describe("kb dedup — normalizeUrl", () => {
  it("lowercases host, drops fragment + trailing slash", () => {
    expect(normalizeUrl("https://Example.COM/Path/#section")).toBe(
      "https://example.com/Path",
    );
  });

  it("strips tracking params (utm_*, gclid, fbclid, ref) but keeps real ones", () => {
    expect(
      normalizeUrl("https://x.io/a?utm_source=g&gclid=1&fbclid=2&ref=tw&id=7"),
    ).toBe("https://x.io/a?id=7");
  });

  it("sorts remaining params for stable canonical form", () => {
    expect(normalizeUrl("https://x.io/a?b=2&a=1")).toBe(
      normalizeUrl("https://x.io/a?a=1&b=2"),
    );
  });

  it("treats /ru and root as DIFFERENT urls (RU/EN not merged)", () => {
    expect(normalizeUrl("https://atlas-system.io/ru/rules")).not.toBe(
      normalizeUrl("https://atlas-system.io/rules"),
    );
  });

  it("returns null for empty/invalid", () => {
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("kb dedup — computeContentHash", () => {
  it("is deterministic and whitespace-normalized", () => {
    const a = computeContentHash("Hello   world\n\ntext");
    const b = computeContentHash("Hello world text");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different text → different hash (RU vs EN are NOT duplicates)", () => {
    const ru = computeContentHash(
      "Правила Smart Cycle и реферальная программа",
    );
    const en = computeContentHash("Smart Cycle rules and referral program");
    expect(ru).not.toBe(en);
  });

  it("identical text at different URLs → SAME hash (content duplicate)", () => {
    const t = "Atlas governance framework: voting and participation.";
    expect(computeContentHash(t)).toBe(computeContentHash(t));
  });

  it("returns null for empty", () => {
    expect(computeContentHash(null)).toBeNull();
    expect(computeContentHash("   ")).toBeNull();
  });
});
