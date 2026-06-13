import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Voice authz regression (P0): signed guest invite tokens + workspace
// membership / room-scoping helpers. We mock IO boundaries (server-only, db,
// membership) and exercise the REAL crypto + access logic.

vi.mock("server-only", () => ({}));

const { findUniqueMock, checkMembershipMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  checkMembershipMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { voiceRoom: { findUnique: findUniqueMock } },
}));
vi.mock("@/lib/services/membership-check", () => ({
  checkMembership: checkMembershipMock,
}));

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-voice";
});

import {
  createVoiceInvite,
  verifyVoiceInvite,
} from "@/lib/services/voice-invite";
import {
  assertMember,
  loadRoomInWorkspace,
  resolveVoiceAccess,
  assertRoomAllowed,
} from "@/lib/services/voice-access";
import { ApiError } from "@/lib/api-error";

const WS_A = "cmaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "cmbbbbbbbbbbbbbbbbbbbbbbb";
const ROOM_1 = "room-1";
const ROOM_2 = "room-2";

describe("voice-invite — signed guest tokens", () => {
  it("valid token round-trips for its room+workspace", () => {
    const t = createVoiceInvite(WS_A, ROOM_1);
    expect(verifyVoiceInvite(t, WS_A, ROOM_1)).toBe(true);
  });

  it("rejects token for a DIFFERENT room or workspace", () => {
    const t = createVoiceInvite(WS_A, ROOM_1);
    expect(verifyVoiceInvite(t, WS_A, ROOM_2)).toBe(false);
    expect(verifyVoiceInvite(t, WS_B, ROOM_1)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const t = createVoiceInvite(WS_A, ROOM_1);
    const [body] = t.split(".");
    expect(verifyVoiceInvite(`${body}.deadbeef`, WS_A, ROOM_1)).toBe(false);
  });

  it("rejects a tampered payload (room swapped in body)", () => {
    const t = createVoiceInvite(WS_A, ROOM_1);
    const sig = t.split(".")[1];
    const forged = Buffer.from(
      JSON.stringify({ w: WS_A, r: ROOM_2, exp: Date.now() + 100000 }),
      "utf8",
    ).toString("base64url");
    expect(verifyVoiceInvite(`${forged}.${sig}`, WS_A, ROOM_2)).toBe(false);
  });

  it("rejects an expired token", () => {
    const t = createVoiceInvite(WS_A, ROOM_1, -1000); // already expired
    expect(verifyVoiceInvite(t, WS_A, ROOM_1)).toBe(false);
  });

  it("rejects malformed / empty tokens", () => {
    for (const bad of ["", undefined, null, "no-dot", "a.b.c", "."]) {
      expect(verifyVoiceInvite(bad as never, WS_A, ROOM_1)).toBe(false);
    }
  });
});

describe("assertMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkMembershipMock.mockResolvedValue(null);
  });

  it("member passes", async () => {
    checkMembershipMock.mockResolvedValue("MEMBER");
    await expect(assertMember(WS_A, "u1", "USER")).resolves.toBeUndefined();
  });

  it("non-member throws 403 WORKSPACE_FORBIDDEN", async () => {
    checkMembershipMock.mockResolvedValue(null);
    await expect(assertMember(WS_A, "u1", "USER")).rejects.toMatchObject({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
    });
  });

  it("global ADMIN bypasses (parity with sibling internal routes)", async () => {
    await expect(assertMember(WS_A, "admin", "ADMIN")).resolves.toBeUndefined();
    expect(checkMembershipMock).not.toHaveBeenCalled();
  });
});

describe("loadRoomInWorkspace — cross-ws IDOR guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns room when it belongs to the workspace", async () => {
    findUniqueMock.mockResolvedValue({ id: ROOM_1, workspaceId: WS_A });
    await expect(loadRoomInWorkspace(ROOM_1, WS_A)).resolves.toMatchObject({
      id: ROOM_1,
    });
  });

  it("throws 404 when room belongs to ANOTHER workspace (IDOR blocked)", async () => {
    findUniqueMock.mockResolvedValue({ id: ROOM_1, workspaceId: WS_B });
    await expect(loadRoomInWorkspace(ROOM_1, WS_A)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(loadRoomInWorkspace(ROOM_1, WS_A)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when room missing", async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(loadRoomInWorkspace("nope", WS_A)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("assertRoomAllowed — private-room allow-list for members", () => {
  const member = (uid: string) =>
    ({ isGuest: false, userId: uid, role: "USER" }) as const;

  it("public room → any member allowed", () => {
    expect(() =>
      assertRoomAllowed(
        { isPrivate: false, allowedUserIds: "[]" },
        member("u1"),
      ),
    ).not.toThrow();
  });

  it("private room, member on allow-list → allowed", () => {
    expect(() =>
      assertRoomAllowed(
        { isPrivate: true, allowedUserIds: JSON.stringify(["u1", "u2"]) },
        member("u1"),
      ),
    ).not.toThrow();
  });

  it("private room, member NOT on allow-list → 403 ROOM_FORBIDDEN", () => {
    expect(() =>
      assertRoomAllowed(
        { isPrivate: true, allowedUserIds: JSON.stringify(["u2"]) },
        member("u1"),
      ),
    ).toThrowError(
      expect.objectContaining({ status: 403, code: "ROOM_FORBIDDEN" }),
    );
  });

  it("private room, GUEST → bypass (invite token already validated)", () => {
    expect(() =>
      assertRoomAllowed(
        { isPrivate: true, allowedUserIds: JSON.stringify(["u2"]) },
        { isGuest: true },
      ),
    ).not.toThrow();
  });

  it("private room, corrupt allow-list → fail closed (403)", () => {
    expect(() =>
      assertRoomAllowed(
        { isPrivate: true, allowedUserIds: "{not json" },
        member("u1"),
      ),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });
});

describe("resolveVoiceAccess — member vs guest gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkMembershipMock.mockResolvedValue(null);
  });

  it("session member → isGuest false + userId", async () => {
    checkMembershipMock.mockResolvedValue("MEMBER");
    const acc = await resolveVoiceAccess({
      session: { user: { id: "u1", role: "USER" } },
      workspaceId: WS_A,
      roomId: ROOM_1,
      inviteToken: null,
    });
    expect(acc).toEqual({ isGuest: false, userId: "u1", role: "USER" });
  });

  it("session NON-member → 403 (no token can save a logged-in non-member)", async () => {
    checkMembershipMock.mockResolvedValue(null);
    await expect(
      resolveVoiceAccess({
        session: { user: { id: "u1", role: "USER" } },
        workspaceId: WS_A,
        roomId: ROOM_1,
        inviteToken: createVoiceInvite(WS_A, ROOM_1), // even with a valid token
      }),
    ).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
  });

  it("guest with VALID invite token → isGuest true", async () => {
    const acc = await resolveVoiceAccess({
      session: null,
      workspaceId: WS_A,
      roomId: ROOM_1,
      inviteToken: createVoiceInvite(WS_A, ROOM_1),
    });
    expect(acc).toEqual({ isGuest: true });
  });

  it("guest with NO / invalid / wrong-room token → 403 INVITE_INVALID", async () => {
    for (const tok of [
      null,
      "garbage",
      createVoiceInvite(WS_B, ROOM_1), // wrong ws
      createVoiceInvite(WS_A, ROOM_2), // wrong room
      createVoiceInvite(WS_A, ROOM_1, -1), // expired
    ]) {
      await expect(
        resolveVoiceAccess({
          session: null,
          workspaceId: WS_A,
          roomId: ROOM_1,
          inviteToken: tok,
        }),
      ).rejects.toMatchObject({ status: 403, code: "INVITE_INVALID" });
    }
  });
});
