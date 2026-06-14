import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level proof that requireWorkspaceAccess({module}) is wired into the
// module-scoped routes: a member whose allowedModules excludes the route's
// module gets 403; an allowed member / unrestricted member / global ADMIN pass;
// a non-member gets 403. Covers the commit-2 sweep wiring (P0 #2).

vi.mock("server-only", () => ({}));

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const memberFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    workspaceMember: {
      findUnique: (...a: unknown[]) => memberFindUnique(...a),
    },
  },
}));

const listKbFiles = vi.fn(async () => []);
vi.mock("@/lib/services/kb/file.service", () => ({
  listKbFiles: (...a: unknown[]) => listKbFiles(...a),
  uploadKbFile: vi.fn(),
}));

const listChannels = vi.fn(async () => []);
vi.mock("@/lib/services/chat-internal/channel.service", () => ({
  listChannels: (...a: unknown[]) => listChannels(...a),
  createChannel: vi.fn(),
}));

import { GET as kbFilesGET } from "@/app/api/workspaces/[id]/kb/files/route";
import { GET as chatGET } from "@/app/api/workspaces/[id]/chat-channels/route";

const kbReq = () =>
  new Request("http://t/api/workspaces/ws-1/kb/files") as never;
const chatReq = () =>
  new Request("http://t/api/workspaces/ws-1/chat-channels") as never;
const P = { params: { id: "ws-1" } };

function asMember(role: "OWNER" | "MEMBER", allowedModules: string[] | null) {
  memberFindUnique.mockResolvedValue({
    role,
    allowedModules:
      allowedModules === null ? null : JSON.stringify(allowedModules),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "USER" } });
});

describe("kb/files GET — knowledge module gate", () => {
  it("restricted member without 'knowledge' → 403, service not called", async () => {
    asMember("MEMBER", ["crm", "tickets"]);
    const res = await kbFilesGET(kbReq(), P);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("MODULE_FORBIDDEN");
    expect(listKbFiles).not.toHaveBeenCalled();
  });

  it("member with 'knowledge' → 200", async () => {
    asMember("MEMBER", ["knowledge"]);
    const res = await kbFilesGET(kbReq(), P);
    expect(res.status).toBe(200);
    expect(listKbFiles).toHaveBeenCalledOnce();
  });

  it("unrestricted member (allowedModules null) → 200", async () => {
    asMember("MEMBER", null);
    const res = await kbFilesGET(kbReq(), P);
    expect(res.status).toBe(200);
  });

  it("non-member → 403 WORKSPACE_FORBIDDEN", async () => {
    memberFindUnique.mockResolvedValue(null);
    const res = await kbFilesGET(kbReq(), P);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WORKSPACE_FORBIDDEN");
    expect(listKbFiles).not.toHaveBeenCalled();
  });

  it("global ADMIN → 200, no membership lookup", async () => {
    mockAuth.mockResolvedValue({ user: { id: "adm", role: "ADMIN" } });
    const res = await kbFilesGET(kbReq(), P);
    expect(res.status).toBe(200);
    expect(memberFindUnique).not.toHaveBeenCalled();
  });
});

describe("chat-channels GET — chat module gate", () => {
  it("restricted member without 'chat' → 403", async () => {
    asMember("MEMBER", ["crm"]);
    const res = await chatGET(chatReq(), P);
    expect(res.status).toBe(403);
    expect(listChannels).not.toHaveBeenCalled();
  });

  it("member with 'chat' → 200", async () => {
    asMember("MEMBER", ["chat"]);
    const res = await chatGET(chatReq(), P);
    expect(res.status).toBe(200);
    expect(listChannels).toHaveBeenCalledOnce();
  });
});
