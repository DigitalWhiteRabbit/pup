import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/services/storage", () => ({
  storage: () => ({
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workspaceMember: { findUnique: vi.fn(), findMany: vi.fn() },
    contentCard: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import {
  resolveContentAccess,
  cardAction,
  updateCard,
} from "@/lib/services/content.service";

const mockDb = db as unknown as {
  workspaceMember: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  contentCard: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// Workspace moderator-pool size for the solo-moderator exception.
function withModeratorCount(n: number) {
  mockDb.workspaceMember.findMany.mockResolvedValue(
    Array.from({ length: n }, () => ({ role: "OWNER", allowedModules: null })),
  );
}

// Полноценная prisma-подобная карточка (для mapCard).
function makeCard(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    workspaceId: "w1",
    authorId: "u1",
    assigneeId: null,
    title: "Тема",
    channel: "TELEGRAM",
    format: "POST",
    priority: "MEDIUM",
    status: "DRAFT",
    visualStatus: "NONE",
    publishDate: null,
    visualBrief: null,
    visualLink: null,
    text: null,
    workComment: null,
    adminComment: null,
    publishedUrl: null,
    publishedExternalId: null,
    autoPublish: false,
    proofChecked: false,
    visualApproved: false,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    author: { id: "u1", login: "smm" },
    assignee: null,
    media: [],
    history: [],
    ...over,
  };
}

function asAuthor() {
  // content:author = видит модуль, но НЕ модератор
  mockDb.workspaceMember.findUnique.mockResolvedValue({
    role: "MEMBER",
    allowedModules: JSON.stringify(["content:author"]),
  });
}
function asModerator() {
  mockDb.workspaceMember.findUnique.mockResolvedValue({
    role: "OWNER",
    allowedModules: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveContentAccess", () => {
  it("ADMIN is always a moderator (no membership lookup)", async () => {
    const res = await resolveContentAccess("w1", "admin", "ADMIN");
    expect(res.isModerator).toBe(true);
    expect(mockDb.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("OWNER is a moderator", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "OWNER",
      allowedModules: null,
    });
    expect((await resolveContentAccess("w1", "u1", "USER")).isModerator).toBe(
      true,
    );
  });

  it("member with full [content] access is a moderator (parent includes moderate)", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content"]),
    });
    expect((await resolveContentAccess("w1", "u1", "USER")).isModerator).toBe(
      true,
    );
  });

  it("SMM author with [content:author] sees the module but is NOT a moderator", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content:author"]),
    });
    expect((await resolveContentAccess("w1", "u1", "USER")).isModerator).toBe(
      false,
    );
  });

  it("member with content:moderate IS a moderator", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content", "content:moderate"]),
    });
    expect((await resolveContentAccess("w1", "u1", "USER")).isModerator).toBe(
      true,
    );
  });

  it("member without content access is forbidden", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["crm"]),
    });
    await expect(resolveContentAccess("w1", "u1", "USER")).rejects.toThrow();
  });

  it("non-member is forbidden", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(resolveContentAccess("w1", "u1", "USER")).rejects.toThrow();
  });
});

describe("cardAction — permission gating", () => {
  function asNonModAuthor() {
    // content:author = автор без модерации
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content:author"]),
    });
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "REVIEW" }),
    );
  }

  it("non-moderator author cannot request-changes (moderator only)", async () => {
    asNonModAuthor();
    await expect(
      cardAction("w1", "c1", "u1", "USER", "request-changes"),
    ).rejects.toThrow();
  });

  it("non-moderator author cannot approve (moderator only)", async () => {
    asNonModAuthor();
    await expect(
      cardAction("w1", "c1", "u1", "USER", "approve"),
    ).rejects.toThrow();
  });

  it("a non-author non-moderator cannot review someone else's card", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content:author"]),
    });
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({
        authorId: "someone-else",
        author: { id: "someone-else", login: "other" },
      }),
    );
    await expect(
      cardAction("w1", "c1", "u1", "USER", "review"),
    ).rejects.toThrow();
  });
});

describe("cardAction — self-approval + server-side readiness (P1-B)", () => {
  const READY = {
    text: "готовый текст",
    proofChecked: true,
    visualApproved: true,
    publishDate: new Date("2026-07-01T00:00:00.000Z"),
  };
  const txOk = () => {
    const tx = {
      contentCard: { update: vi.fn().mockResolvedValue({}) },
      contentCardHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(
      async (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    return tx;
  };

  it("with 2+ moderators, an author-moderator cannot approve their own card", async () => {
    asModerator(); // OWNER, actor "u1" == authorId
    withModeratorCount(2); // not solo → strict separation
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "REVIEW", authorId: "u1" }),
    );
    await expect(
      cardAction("w1", "c1", "u1", "USER", "approve"),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN", status: 403 });
  });

  it("SOLO moderator CAN approve + publish their own card", async () => {
    asModerator(); // OWNER, actor "u1" == authorId
    withModeratorCount(1); // sole moderator → exception
    // approve
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(makeCard({ status: "REVIEW", authorId: "u1" }))
      .mockResolvedValueOnce(
        makeCard({ status: "READY", authorId: "u1", proofChecked: true }),
      );
    txOk();
    await cardAction("w1", "c1", "u1", "USER", "approve");
    // publish (fully ready, POST → no visual needed)
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(
        makeCard({
          status: "READY",
          authorId: "u1",
          format: "POST",
          ...READY,
        }),
      )
      .mockResolvedValueOnce(
        makeCard({ status: "PUBLISHED", authorId: "u1", format: "POST" }),
      );
    txOk();
    const res = await cardAction("w1", "c1", "u1", "USER", "publish");
    expect(res.card.status).toBe("PUBLISHED");
  });

  it("a DIFFERENT moderator CAN approve the author's card", async () => {
    asModerator();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(makeCard({ status: "REVIEW", authorId: "u1" }))
      .mockResolvedValueOnce(
        makeCard({ status: "READY", authorId: "u1", proofChecked: true }),
      );
    const tx = txOk();
    await cardAction("w1", "c1", "mod", "USER", "approve");
    expect(tx.contentCard.update).toHaveBeenCalled();
  });

  it("with 2+ moderators, the author (even a moderator) can't publish → 403", async () => {
    asModerator();
    withModeratorCount(2);
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "READY", authorId: "u1", ...READY }),
    );
    await expect(
      cardAction("w1", "c1", "u1", "USER", "publish"),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN" });
  });

  it("VISUAL format (VIDEO) without visualApproved → 422 not ready", async () => {
    asModerator();
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({
        status: "READY",
        authorId: "u1",
        format: "VIDEO", // visual-required
        text: "t",
        proofChecked: true,
        visualApproved: false, // missing visual
        publishDate: new Date("2026-07-01T00:00:00.000Z"),
      }),
    );
    await expect(
      cardAction("w1", "c1", "mod", "USER", "publish"),
    ).rejects.toMatchObject({ code: "CARD_NOT_READY", status: 422 });
  });

  it("TEXT-only format (POST) publishes WITHOUT a visual (text+proof+date)", async () => {
    asModerator();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(
        makeCard({
          status: "READY",
          authorId: "u1",
          format: "POST",
          text: "готовый текст",
          proofChecked: true,
          visualApproved: false, // no visual — fine for POST
          publishDate: new Date("2026-07-01T00:00:00.000Z"),
        }),
      )
      .mockResolvedValueOnce(
        makeCard({ status: "PUBLISHED", authorId: "u1", format: "POST" }),
      );
    txOk();
    const res = await cardAction("w1", "c1", "mod", "USER", "publish");
    expect(res.card.status).toBe("PUBLISHED");
  });

  it("publish by a different moderator, card 4/4 → PUBLISHED", async () => {
    asModerator();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(
        makeCard({ status: "READY", authorId: "u1", ...READY }),
      )
      .mockResolvedValueOnce(
        makeCard({ status: "PUBLISHED", authorId: "u1", ...READY }),
      );
    txOk();
    const res = await cardAction("w1", "c1", "mod", "USER", "publish");
    expect(res.card.status).toBe("PUBLISHED");
  });

  it("non-moderator author cannot publish (and it's flagged as self-approval)", async () => {
    mockDb.workspaceMember.findUnique.mockResolvedValue({
      role: "MEMBER",
      allowedModules: JSON.stringify(["content:author"]),
    });
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "READY", authorId: "u1", ...READY }),
    );
    await expect(
      cardAction("w1", "c1", "u1", "USER", "publish"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("updateCard — field-level authorization", () => {
  it("author cannot set status=PUBLISHED via PATCH", async () => {
    asAuthor();
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "DRAFT" }),
    );
    await expect(
      updateCard("w1", "c1", "u1", "USER", { status: "PUBLISHED" }),
    ).rejects.toThrow();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("author cannot set status=REVIEW via PATCH (only IDEA/DRAFT/PAUSED)", async () => {
    asAuthor();
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ status: "DRAFT" }),
    );
    await expect(
      updateCard("w1", "c1", "u1", "USER", { status: "REVIEW" }),
    ).rejects.toThrow();
  });

  it("author CAN set status=PAUSED via PATCH", async () => {
    asAuthor();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(makeCard({ status: "DRAFT" }))
      .mockResolvedValueOnce(makeCard({ status: "PAUSED" }));
    const tx = {
      contentCard: { update: vi.fn().mockResolvedValue({}) },
      contentCardHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(
      async (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    const res = await updateCard("w1", "c1", "u1", "USER", {
      status: "PAUSED",
    });
    expect(tx.contentCard.update).toHaveBeenCalled();
    expect(res.status).toBe("PAUSED");
  });

  it("author cannot set visualStatus=OK via PATCH", async () => {
    asAuthor();
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ visualStatus: "NONE" }),
    );
    await expect(
      updateCard("w1", "c1", "u1", "USER", { visualStatus: "OK" }),
    ).rejects.toThrow();
  });

  it("author CAN set visualStatus=IN_REVIEW via PATCH", async () => {
    asAuthor();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(makeCard({ visualStatus: "NONE" }))
      .mockResolvedValueOnce(makeCard({ visualStatus: "IN_REVIEW" }));
    const tx = {
      contentCard: { update: vi.fn().mockResolvedValue({}) },
      contentCardHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(
      async (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    const res = await updateCard("w1", "c1", "u1", "USER", {
      visualStatus: "IN_REVIEW",
    });
    expect(res.visualStatus).toBe("IN_REVIEW");
  });

  it("author cannot write adminComment via PATCH", async () => {
    asAuthor();
    mockDb.contentCard.findUnique.mockResolvedValue(
      makeCard({ adminComment: null }),
    );
    await expect(
      updateCard("w1", "c1", "u1", "USER", { adminComment: "правки" }),
    ).rejects.toThrow();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("moderator CAN set status=PUBLISHED, visualStatus=OK and adminComment", async () => {
    asModerator();
    mockDb.contentCard.findUnique
      .mockResolvedValueOnce(
        makeCard({
          status: "READY",
          visualStatus: "IN_REVIEW",
          adminComment: null,
        }),
      )
      .mockResolvedValueOnce(
        makeCard({
          status: "PUBLISHED",
          visualStatus: "OK",
          adminComment: "ок",
        }),
      );
    const tx = {
      contentCard: { update: vi.fn().mockResolvedValue({}) },
      contentCardHistory: { create: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(
      async (cb: (t: typeof tx) => unknown) => cb(tx),
    );
    const res = await updateCard("w1", "c1", "mod", "USER", {
      status: "PUBLISHED",
      visualStatus: "OK",
      adminComment: "ок",
    });
    expect(tx.contentCard.update).toHaveBeenCalled();
    expect(res.status).toBe("PUBLISHED");
    expect(res.visualStatus).toBe("OK");
    expect(res.adminComment).toBe("ок");
  });
});
