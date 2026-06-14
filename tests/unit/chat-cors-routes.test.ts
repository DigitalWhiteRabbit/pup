import { describe, it, expect, vi, beforeEach } from "vitest";

// After removing the edge-middleware CORS block, the public chat routes must
// enforce CORS themselves (Node runtime + DB → per-workspace allowlist works).
// These tests exercise the route OPTIONS handlers end-to-end.

vi.mock("server-only", () => ({}));

const { wsFindUnique } = vi.hoisted(() => ({ wsFindUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { workspace: { findUnique: wsFindUnique } },
}));

const { storageExists } = vi.hoisted(() => ({ storageExists: vi.fn() }));
vi.mock("@/lib/services/storage", () => ({
  storage: () => ({
    exists: storageExists,
    download: vi.fn(async () => new ReadableStream()),
  }),
}));

import { OPTIONS as configOPTIONS } from "@/app/api/chat/[slug]/config/route";
import {
  OPTIONS as avatarOPTIONS,
  GET as avatarGET,
} from "@/app/api/chat/avatars/[...path]/route";

const opt = (origin: string) =>
  new Request("http://t", { method: "OPTIONS", headers: { origin } });

beforeEach(() => vi.clearAllMocks());

describe("config OPTIONS — per-workspace allowlist at the route layer", () => {
  const P = { params: Promise.resolve({ slug: "shop" }) };

  it("no allowlist configured → ACAO '*' (widget keeps working)", async () => {
    wsFindUnique.mockResolvedValue({ chatAllowedEmbedOrigins: null });
    const res = await configOPTIONS(opt("https://anything.example"), P);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("allowlist + listed origin → echoes that origin", async () => {
    wsFindUnique.mockResolvedValue({
      chatAllowedEmbedOrigins: '["https://shop.example"]',
    });
    const res = await configOPTIONS(opt("https://shop.example"), P);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://shop.example",
    );
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("allowlist + UNlisted origin → does NOT reflect the caller", async () => {
    wsFindUnique.mockResolvedValue({
      chatAllowedEmbedOrigins: '["https://shop.example"]',
    });
    const res = await configOPTIONS(opt("https://evil.example"), P);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe(
      "https://evil.example",
    );
  });

  it("DB error in getEmbedOrigins → fails open to '*' (no widget breakage)", async () => {
    wsFindUnique.mockRejectedValue(new Error("db down"));
    const res = await configOPTIONS(opt("https://shop.example"), P);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("avatars route — CORS present after middleware removal", () => {
  it("OPTIONS → 204 with ACAO '*' (no slug → no allowlist)", async () => {
    const res = await avatarOPTIONS(opt("https://shop.example") as never);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("GET 404 (missing) still carries CORS headers", async () => {
    storageExists.mockResolvedValue(false);
    const res = await avatarGET(
      new Request("http://t", {
        headers: { origin: "https://shop.example" },
      }) as never,
      { params: Promise.resolve({ path: ["x.png"] }) },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
