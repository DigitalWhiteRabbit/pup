import { describe, it, expect, vi, beforeEach } from "vitest";

// Регресс-тест: контракт GET /api/workspaces/[id]/my-modules ДОЛЖЕН быть
// { allowedModules: <массив | null> } (как на origin/main). Раньше wip-версия
// отдавала голое значение → потребители (Sidebar/overview) читали .allowedModules
// = undefined → ограниченный участник видел ВСЕ модули (регресс прав видимости).

vi.mock("server-only", () => ({}));

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    workspaceMember: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

import { GET } from "@/app/api/workspaces/[id]/my-modules/route";
import { checkModuleAccess } from "@/lib/module-access";

const PARAMS = { params: { id: "ws-1" } };
const req = () => new Request("http://test/api/workspaces/ws-1/my-modules");

async function callGet() {
  const res = await GET(req(), PARAMS);
  const body = await res.json();
  return { status: res.status, body };
}

describe("GET /api/workspaces/[id]/my-modules — контракт { allowedModules }", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ограниченный MEMBER → { allowedModules: <массив> } (видит только разрешённые)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "USER" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: '["crm"]',
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    // форма-обёртка, не голое значение
    expect(body).toHaveProperty("allowedModules");
    expect(body.allowedModules).toEqual(["crm"]);
    // гейтинг применяет список
    expect(checkModuleAccess(body.allowedModules, "crm")).toBe(true);
    expect(checkModuleAccess(body.allowedModules, "tickets")).toBe(false);
  });

  it("OWNER → { allowedModules: null } (полный доступ)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "owner", role: "USER" } });
    mockFindUnique.mockResolvedValue({ role: "OWNER", allowedModules: null });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body).toHaveProperty("allowedModules");
    expect(body.allowedModules).toBeNull();
    expect(checkModuleAccess(body.allowedModules, "tickets")).toBe(true);
  });

  it("ADMIN → { allowedModules: null } (полный доступ, без запроса членства)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "adm", role: "ADMIN" } });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.allowedModules).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(checkModuleAccess(body.allowedModules, "users")).toBe(true);
  });

  it("MEMBER без ограничений (allowedModules null) → { allowedModules: null }", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "USER" } });
    mockFindUnique.mockResolvedValue({ role: "MEMBER", allowedModules: null });
    const { body } = await callGet();
    expect(body.allowedModules).toBeNull();
  });

  it("не-участник → { allowedModules: null } (как на origin/main)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "stranger", role: "USER" } });
    mockFindUnique.mockResolvedValue(null);
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body).toHaveProperty("allowedModules");
    expect(body.allowedModules).toBeNull();
  });

  it("битый JSON в allowedModules → { allowedModules: null } (full, не падает)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u3", role: "USER" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: "{not-json",
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.allowedModules).toBeNull();
  });

  it("не авторизован → 401", async () => {
    mockAuth.mockResolvedValue(null);
    const { status } = await callGet();
    expect(status).toBe(401);
  });

  it("ни одна success-ветка не отдаёт голое значение (всегда объект с ключом)", async () => {
    const cases = [
      { user: { id: "a", role: "ADMIN" }, member: undefined },
      { user: { id: "o", role: "USER" }, member: { role: "OWNER", allowedModules: null } },
      { user: { id: "m", role: "USER" }, member: { role: "MEMBER", allowedModules: '["crm"]' } },
      { user: { id: "s", role: "USER" }, member: null },
    ];
    for (const c of cases) {
      vi.clearAllMocks();
      mockAuth.mockResolvedValue({ user: c.user });
      if (c.member !== undefined) mockFindUnique.mockResolvedValue(c.member);
      const { body } = await callGet();
      expect(
        typeof body === "object" && body !== null && "allowedModules" in body,
      ).toBe(true);
    }
  });
});
