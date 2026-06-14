import { describe, it, expect, vi, beforeEach } from "vitest";

// Chat channel-level access regression (P0 PRIVATE/DM leak + cross-ws IDOR).
// Mocks the IO boundaries; exercises the real access + SSE-scoping logic.

vi.mock("server-only", () => ({}));

const {
  channelFindUnique,
  memberFindUnique,
  msgFindUnique,
  checkMembershipMock,
} = vi.hoisted(() => ({
  channelFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  msgFindUnique: vi.fn(),
  checkMembershipMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    chatChannel: { findUnique: channelFindUnique },
    chatChannelMember: { findUnique: memberFindUnique },
    chatMsg: { findUnique: msgFindUnique },
  },
}));
vi.mock("@/lib/services/membership-check", () => ({
  checkMembership: checkMembershipMock,
}));

import {
  assertChannelAccess,
  assertMessageChannelAccess,
  resolveChannelDelivery,
} from "@/lib/services/chat-internal/channel-access";
import {
  addSSEClient,
  removeSSEClient,
  broadcastToChannelMembers,
} from "@/lib/services/chat-internal/sse.service";

const WS_A = "wsA";
const WS_B = "wsB";
const CH = "ch1";

beforeEach(() => {
  vi.clearAllMocks();
  channelFindUnique.mockResolvedValue(null);
  memberFindUnique.mockResolvedValue(null);
  msgFindUnique.mockResolvedValue(null);
  checkMembershipMock.mockResolvedValue(null);
});

describe("assertChannelAccess", () => {
  it("cross-workspace channel → 404 (IDOR blocked)", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_B,
      type: "PUBLIC",
    });
    await expect(
      assertChannelAccess(CH, WS_A, "u1", "USER"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("missing channel → 404", async () => {
    channelFindUnique.mockResolvedValue(null);
    await expect(
      assertChannelAccess(CH, WS_A, "u1", "USER"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("PRIVATE: member → ok, non-member → 403 CHANNEL_FORBIDDEN", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_A,
      type: "PRIVATE",
    });
    memberFindUnique.mockResolvedValue({ userId: "u1" });
    await expect(
      assertChannelAccess(CH, WS_A, "u1", "USER"),
    ).resolves.toMatchObject({ id: CH });

    memberFindUnique.mockResolvedValue(null);
    await expect(
      assertChannelAccess(CH, WS_A, "u2", "USER"),
    ).rejects.toMatchObject({ status: 403, code: "CHANNEL_FORBIDDEN" });
  });

  it("DM: only a channel member passes", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_A,
      type: "DM",
    });
    memberFindUnique.mockResolvedValue(null);
    await expect(
      assertChannelAccess(CH, WS_A, "outsider", "USER"),
    ).rejects.toMatchObject({ status: 403, code: "CHANNEL_FORBIDDEN" });
  });

  it("PUBLIC: workspace member → ok, non-member of ws → 403", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_A,
      type: "PUBLIC",
    });
    checkMembershipMock.mockResolvedValue("MEMBER");
    await expect(
      assertChannelAccess(CH, WS_A, "u1", "USER"),
    ).resolves.toMatchObject({ id: CH });
    // channel membership table is NOT consulted for PUBLIC
    expect(memberFindUnique).not.toHaveBeenCalled();

    checkMembershipMock.mockResolvedValue(null);
    await expect(
      assertChannelAccess(CH, WS_A, "stranger", "USER"),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("ADMIN bypasses channel membership (parity; P0 #3)", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_A,
      type: "PRIVATE",
    });
    await expect(
      assertChannelAccess(CH, WS_A, "admin", "ADMIN"),
    ).resolves.toMatchObject({ id: CH });
    expect(memberFindUnique).not.toHaveBeenCalled();
  });

  it("ADMIN still cannot reach a channel of ANOTHER workspace (404)", async () => {
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_B,
      type: "PRIVATE",
    });
    await expect(
      assertChannelAccess(CH, WS_A, "admin", "ADMIN"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("assertMessageChannelAccess", () => {
  it("missing message → 404", async () => {
    msgFindUnique.mockResolvedValue(null);
    await expect(
      assertMessageChannelAccess("m1", WS_A, "u1", "USER"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("resolves channel + blocks cross-ws message (404)", async () => {
    msgFindUnique.mockResolvedValue({ channelId: CH, authorId: "author" });
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_B,
      type: "PUBLIC",
    });
    await expect(
      assertMessageChannelAccess("m1", WS_A, "u1", "USER"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns channelId+authorId for an accessible private channel member", async () => {
    msgFindUnique.mockResolvedValue({ channelId: CH, authorId: "author" });
    channelFindUnique.mockResolvedValue({
      id: CH,
      workspaceId: WS_A,
      type: "PRIVATE",
    });
    memberFindUnique.mockResolvedValue({ userId: "u1" });
    await expect(
      assertMessageChannelAccess("m1", WS_A, "u1", "USER"),
    ).resolves.toEqual({ channelId: CH, authorId: "author" });
  });
});

describe("resolveChannelDelivery — SSE recipient scope", () => {
  it("PRIVATE → channel members only", async () => {
    channelFindUnique.mockResolvedValue({
      workspaceId: WS_A,
      type: "PRIVATE",
      members: [{ userId: "u1" }, { userId: "u2" }],
    });
    await expect(resolveChannelDelivery(CH)).resolves.toEqual({
      workspaceId: WS_A,
      recipients: ["u1", "u2"],
    });
  });

  it("DM → the two participants only", async () => {
    channelFindUnique.mockResolvedValue({
      workspaceId: WS_A,
      type: "DM",
      members: [{ userId: "a" }, { userId: "b" }],
    });
    await expect(resolveChannelDelivery(CH)).resolves.toEqual({
      workspaceId: WS_A,
      recipients: ["a", "b"],
    });
  });

  it("PUBLIC/GENERAL → null (all workspace clients)", async () => {
    channelFindUnique.mockResolvedValue({
      workspaceId: WS_A,
      type: "PUBLIC",
      members: [{ userId: "u1" }],
    });
    await expect(resolveChannelDelivery(CH)).resolves.toEqual({
      workspaceId: WS_A,
      recipients: null,
    });
  });
});

describe("broadcastToChannelMembers — PRIVATE/DM never reach non-members", () => {
  function fakeClient() {
    const calls: string[] = [];
    const controller = {
      enqueue: (b: Uint8Array) => calls.push(new TextDecoder().decode(b)),
    } as unknown as ReadableStreamDefaultController;
    const encoder = {
      encode: (s: string) => new TextEncoder().encode(s),
    } as TextEncoder;
    return { calls, controller, encoder };
  }

  it("PRIVATE/DM: only member clients receive the event; non-member does NOT", () => {
    const ws = "wsBroadcast1";
    const a = fakeClient();
    const b = fakeClient();
    const outsider = fakeClient();
    addSSEClient(ws, "ca", "userA", a.controller, a.encoder);
    addSSEClient(ws, "cb", "userB", b.controller, b.encoder);
    addSSEClient(ws, "cx", "outsider", outsider.controller, outsider.encoder);

    broadcastToChannelMembers(ws, ["userA", "userB"], {
      type: "new_message",
      data: { secret: "private content" },
    });

    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
    expect(outsider.calls.length).toBe(0); // leak prevented
    expect(a.calls[0]).toContain("private content");

    removeSSEClient(ws, "ca");
    removeSSEClient(ws, "cb");
    removeSSEClient(ws, "cx");
  });

  it("recipients=null (PUBLIC/GENERAL) → all workspace clients receive", () => {
    const ws = "wsBroadcast2";
    const a = fakeClient();
    const b = fakeClient();
    addSSEClient(ws, "ca", "userA", a.controller, a.encoder);
    addSSEClient(ws, "cb", "userB", b.controller, b.encoder);

    broadcastToChannelMembers(ws, null, { type: "new_message", data: {} });

    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);

    removeSSEClient(ws, "ca");
    removeSSEClient(ws, "cb");
  });
});
