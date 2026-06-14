import { describe, it, expect, vi, beforeEach } from "vitest";

// Unified workspace-access guard (P0 authz): membership, module-access,
// owner-only, and service-account workspace/scope binding (NO global-admin
// bypass for service tokens on internal routes).

vi.mock("server-only", () => ({}));

const { memberFindUnique } = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { workspaceMember: { findUnique: memberFindUnique } },
}));

import {
  requireWorkspaceAccess,
  accessCtxFromSession,
  type AccessCtx,
} from "@/lib/services/workspace-access";

const WS = "ws-1";
const userCtx = (id: string, role = "USER"): AccessCtx => ({
  type: "user",
  id,
  role,
});
const svcCtx = (workspaceId: string, scopes: string[] = []): AccessCtx => ({
  type: "service",
  id: "sa-1",
  workspaceId,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scopes: scopes as any,
});

function member(role: "OWNER" | "MEMBER", allowedModules: string[] | null) {
  memberFindUnique.mockResolvedValue({
    role,
    allowedModules:
      allowedModules === null ? null : JSON.stringify(allowedModules),
  });
}

beforeEach(() => memberFindUnique.mockReset());

describe("requireWorkspaceAccess — regular users (membership)", () => {
  it("non-member → 403 WORKSPACE_FORBIDDEN", async () => {
    memberFindUnique.mockResolvedValue(null);
    await expect(
      requireWorkspaceAccess(userCtx("u1"), WS),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("member → allowed, role MEMBER", async () => {
    member("MEMBER", null);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS);
    expect(a).toMatchObject({
      kind: "user",
      role: "MEMBER",
      isGlobalAdmin: false,
    });
  });

  it("owner → allowed, full module access (allowedModules null)", async () => {
    member("OWNER", null);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS);
    expect(a).toMatchObject({ role: "OWNER", allowedModules: null });
  });
});

describe("requireWorkspaceAccess — module access", () => {
  it("restricted member, closed module → 403 MODULE_FORBIDDEN", async () => {
    member("MEMBER", ["crm", "tickets"]);
    await expect(
      requireWorkspaceAccess(userCtx("u1"), WS, { module: "users" }),
    ).rejects.toMatchObject({ status: 403, code: "MODULE_FORBIDDEN" });
  });

  it("restricted member, allowed module → 200", async () => {
    member("MEMBER", ["crm", "tickets"]);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS, {
      module: "crm",
    });
    expect(a.role).toBe("MEMBER");
  });

  it("restricted member, sub-module of an allowed parent → 200", async () => {
    member("MEMBER", ["marketing"]);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS, {
      module: "marketing:leads",
    });
    expect(a.role).toBe("MEMBER");
  });

  it("owner is never module-restricted → 200 on any module", async () => {
    member("OWNER", null);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS, {
      module: "users",
    });
    expect(a.role).toBe("OWNER");
  });

  it("malformed allowedModules JSON → treated as full access", async () => {
    memberFindUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: "{bad",
    });
    const a = await requireWorkspaceAccess(userCtx("u1"), WS, {
      module: "users",
    });
    expect(a.allowedModules).toBeNull();
  });
});

describe("requireWorkspaceAccess — human global ADMIN (sees all)", () => {
  it("ADMIN → allowed everywhere, no membership lookup, any module", async () => {
    const a = await requireWorkspaceAccess(userCtx("admin", "ADMIN"), WS, {
      module: "users",
    });
    expect(a).toMatchObject({ isGlobalAdmin: true, role: null });
    expect(memberFindUnique).not.toHaveBeenCalled();
  });

  it("ADMIN bypasses requireOwner too", async () => {
    const a = await requireWorkspaceAccess(userCtx("admin", "ADMIN"), WS, {
      requireOwner: true,
    });
    expect(a.isGlobalAdmin).toBe(true);
  });
});

describe("requireWorkspaceAccess — owner-only routes", () => {
  it("non-owner member + requireOwner → 403", async () => {
    member("MEMBER", null);
    await expect(
      requireWorkspaceAccess(userCtx("u1"), WS, { requireOwner: true }),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("owner + requireOwner → 200", async () => {
    member("OWNER", null);
    const a = await requireWorkspaceAccess(userCtx("u1"), WS, {
      requireOwner: true,
    });
    expect(a.role).toBe("OWNER");
  });
});

describe("requireWorkspaceAccess — service accounts (no global-admin bypass)", () => {
  it("service token on its OWN workspace → allowed", async () => {
    const a = await requireWorkspaceAccess(svcCtx(WS, ["users:read"]), WS, {
      scope: "users:read",
    });
    expect(a).toMatchObject({ kind: "service", isGlobalAdmin: false });
    expect(memberFindUnique).not.toHaveBeenCalled();
  });

  it("service token on a DIFFERENT workspace → 403 WORKSPACE_FORBIDDEN", async () => {
    await expect(
      requireWorkspaceAccess(svcCtx("other-ws"), WS),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("service token missing required scope → 403 SCOPE_FORBIDDEN", async () => {
    await expect(
      requireWorkspaceAccess(svcCtx(WS, ["tickets:read"]), WS, {
        scope: "users:read",
      }),
    ).rejects.toMatchObject({ status: 403, code: "SCOPE_FORBIDDEN" });
  });

  it("service token is NOT an owner (requireOwner → 403)", async () => {
    await expect(
      requireWorkspaceAccess(svcCtx(WS), WS, { requireOwner: true }),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });
});

describe("accessCtxFromSession", () => {
  it("maps a session into a user AccessCtx with defaulted role", () => {
    expect(accessCtxFromSession({ user: { id: "u9" } })).toEqual({
      type: "user",
      id: "u9",
      role: "USER",
    });
    expect(
      accessCtxFromSession({ user: { id: "a", role: "ADMIN" } }),
    ).toMatchObject({ role: "ADMIN" });
  });
});
