import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// Authz regression set for the external v1 API (P0 cross-tenant IDOR).
// We mock the IO boundaries (session, service-token verify, rate-limit,
// membership) and exercise the REAL guard logic in withServiceAuth +
// requireScope/requireWorkspace.

vi.mock("server-only", () => ({}));

const { authMock, verifyTokenMock, checkMembershipMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  checkMembershipMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/services/service-account.service", () => ({
  verifyToken: verifyTokenMock,
}));
vi.mock("@/lib/services/auth/service-account-rate-limit", () => ({
  checkServiceAccountRateLimit: vi.fn(() => ({
    allowed: true,
    remaining: 999,
  })),
}));
vi.mock("@/lib/services/membership-check", () => ({
  checkMembership: checkMembershipMock,
}));

import { withServiceAuth } from "@/lib/middleware/with-service-auth";

const WS_A = "cmaaaaaaaaaaaaaaaaaaaaaaa"; // 25-char cuid-ish
const WS_B = "cmbbbbbbbbbbbbbbbbbbbbbbb";

function makeReq(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) } as unknown as Parameters<
    ReturnType<typeof withServiceAuth>
  >[0];
}

function run(workspaceId: string, headers: Record<string, string> = {}) {
  const handler = vi.fn(async () => NextResponse.json({ ok: true }));
  const wrapped = withServiceAuth("tasks:read", handler);
  return {
    handler,
    res: wrapped(makeReq(headers), {
      params: Promise.resolve({ workspaceId }),
    }),
  };
}

describe("v1 authz — cross-tenant IDOR guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue(null);
    verifyTokenMock.mockResolvedValue(null);
    checkMembershipMock.mockResolvedValue(null);
  });

  it("user MEMBER of own ws A → 200 (handler runs)", async () => {
    authMock.mockResolvedValue({
      user: { id: "u1", role: "USER", login: "u1" },
    });
    checkMembershipMock.mockResolvedValue("MEMBER");
    const { handler, res } = run(WS_A);
    const r = await res;
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(checkMembershipMock).toHaveBeenCalledWith(WS_A, "u1");
  });

  it("user NOT a member of ws B → 403, handler NOT called", async () => {
    authMock.mockResolvedValue({
      user: { id: "u1", role: "USER", login: "u1" },
    });
    checkMembershipMock.mockResolvedValue(null); // not a member
    const { handler, res } = run(WS_B);
    const r = await res;
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("WORKSPACE_FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("global ADMIN who is NOT a member → 403 on external API (no platform bypass)", async () => {
    authMock.mockResolvedValue({
      user: { id: "admin", role: "ADMIN", login: "a" },
    });
    checkMembershipMock.mockResolvedValue(null);
    const { handler, res } = run(WS_B);
    const r = await res;
    expect(r.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("service token bound to ws A, correct scope, request ws A → 200", async () => {
    verifyTokenMock.mockResolvedValue({
      id: "sa1",
      name: "atlas",
      scopes: ["tasks:read"],
      workspaceId: WS_A,
      allowedIPs: [],
    });
    const { handler, res } = run(WS_A, { authorization: "Bearer tok" });
    const r = await res;
    expect(r.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    // membership check must NOT run for service tokens
    expect(checkMembershipMock).not.toHaveBeenCalled();
  });

  it("service token bound to ws A, request ws B → 403 (cross-ws token)", async () => {
    verifyTokenMock.mockResolvedValue({
      id: "sa1",
      name: "atlas",
      scopes: ["tasks:read"],
      workspaceId: WS_A,
      allowedIPs: [],
    });
    const { handler, res } = run(WS_B, { authorization: "Bearer tok" });
    const r = await res;
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("WORKSPACE_FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("service token missing the required scope → 403", async () => {
    verifyTokenMock.mockResolvedValue({
      id: "sa1",
      name: "atlas",
      scopes: ["customers:read"], // lacks tasks:read
      workspaceId: WS_A,
      allowedIPs: [],
    });
    const { handler, res } = run(WS_A, { authorization: "Bearer tok" });
    const r = await res;
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("SCOPE_FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("no session and no token → 401", async () => {
    const { handler, res } = run(WS_A);
    const r = await res;
    expect(r.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
