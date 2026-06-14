import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";

// Public chat-widget CORS (P1): per-workspace allowlist, never reflects an
// arbitrary Origin, never sets credentials.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { workspace: { findUnique: vi.fn() } } }));

import {
  corsHeaders,
  corsResponse,
  withCors,
  parseAllowedOrigins,
} from "@/lib/services/chat/cors";

describe("parseAllowedOrigins", () => {
  it("parses a JSON string array", () => {
    expect(parseAllowedOrigins('["https://a.com","https://b.com"]')).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
  it("returns [] for null / junk / non-array / non-strings", () => {
    expect(parseAllowedOrigins(null)).toEqual([]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("not json")).toEqual([]);
    expect(parseAllowedOrigins('{"x":1}')).toEqual([]);
    expect(parseAllowedOrigins("[1,2,3]")).toEqual([]);
  });
});

describe("corsHeaders", () => {
  it("no allowlist → static '*', no Vary, never credentials", () => {
    const h = corsHeaders("https://evil.example");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Vary"]).toBeUndefined();
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("allowlist + listed origin → echoes that origin + Vary: Origin", () => {
    const allowed = ["https://shop.example", "https://app.example"];
    const h = corsHeaders("https://app.example", allowed);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example");
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("allowlist + UNlisted origin → does NOT reflect caller (browser blocks)", () => {
    const allowed = ["https://shop.example"];
    const h = corsHeaders("https://evil.example", allowed);
    expect(h["Access-Control-Allow-Origin"]).not.toBe("https://evil.example");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://shop.example");
  });

  it("allowlist + no Origin header → first allowed (non-'*')", () => {
    const h = corsHeaders(null, ["https://shop.example"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("https://shop.example");
  });
});

describe("corsResponse / withCors", () => {
  it("corsResponse is a 204 with cors headers", () => {
    const res = corsResponse("https://x.example", ["https://x.example"]);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://x.example",
    );
  });
  it("withCors copies headers onto an existing response, no credentials", () => {
    const res = withCors(
      NextResponse.json({ ok: true }),
      "https://evil.example",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
