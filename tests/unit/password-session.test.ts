import { describe, it, expect, vi, beforeEach } from "vitest";

// Password change → session invalidation (P1-A):
// - sets passwordChangedAt (the JWT epoch gate),
// - invalidates OTHER sessions (cache bust → stale tokens rejected),
// - keeps the CURRENT session (unstable_update re-issues its token),
// - wrong current password → 400 (no change), brute-force rate-limited.

vi.mock("server-only", () => ({}));

const { mockAuth, mockUpdate, mockInvalidate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockUpdate: vi.fn(),
  mockInvalidate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
  unstable_update: mockUpdate,
  invalidateUserCache: mockInvalidate,
}));

const { userFindUnique, userUpdate } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: userFindUnique, update: userUpdate } },
}));

const { bcryptCompare, bcryptHash } = vi.hoisted(() => ({
  bcryptCompare: vi.fn(),
  bcryptHash: vi.fn(async () => "new-hash"),
}));
vi.mock("bcrypt", () => ({
  default: { compare: bcryptCompare, hash: bcryptHash },
}));

import { PATCH } from "@/app/api/profile/password/route";

let uid = 0;
function patch(body: unknown, userId: string) {
  return PATCH(
    new Request("http://t", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "x-forwarded-for": `10.0.0.${++uid % 250}` },
    }),
  );
  void userId;
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ password: "old-hash" });
  userUpdate.mockResolvedValue({});
  bcryptHash.mockResolvedValue("new-hash");
});

const GOOD = { currentPassword: "OldPass1", newPassword: "NewPass1" };

describe("PATCH /api/profile/password", () => {
  it("correct current password → sets passwordChangedAt, invalidates others, re-issues current", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-a", role: "USER" } });
    bcryptCompare.mockResolvedValue(true);

    const res = await patch(GOOD, "user-a");
    expect(res.status).toBe(200);

    // passwordChangedAt written (the epoch gate)
    const upd = userUpdate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data.password).toBe("new-hash");
    expect(upd.data.passwordChangedAt).toBeInstanceOf(Date);

    // other sessions invalidated + current session re-issued
    expect(mockInvalidate).toHaveBeenCalledWith("user-a");
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("wrong current password → 400, nothing changed/invalidated", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-b", role: "USER" } });
    bcryptCompare.mockResolvedValue(false);

    const res = await patch(GOOD, "user-b");
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("unauthenticated → 401", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await patch(GOOD, "x");
    expect(res.status).toBe(401);
  });

  it("re-issue failure still changes password (others invalidated)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-c", role: "USER" } });
    bcryptCompare.mockResolvedValue(true);
    mockUpdate.mockRejectedValue(new Error("no cookie ctx"));

    const res = await patch(GOOD, "user-c");
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledWith("user-c");
  });

  it("brute-force: 11th attempt within window → 429", async () => {
    mockAuth.mockResolvedValue({ user: { id: "bf-user", role: "USER" } });
    bcryptCompare.mockResolvedValue(false);
    // fixed IP so the per-user+per-IP limiter (10/15min) trips deterministically
    const fixedReq = () =>
      PATCH(
        new Request("http://t", {
          method: "PATCH",
          body: JSON.stringify(GOOD),
          headers: { "x-forwarded-for": "203.0.113.7" },
        }),
      );
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await fixedReq();
    expect(last?.status).toBe(429);
  });
});
