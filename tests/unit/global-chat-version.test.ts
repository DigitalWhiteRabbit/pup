import { describe, it, expect, vi, beforeEach } from "vitest";

// Global-chat cheap change-signature (P1-C): the client polls this instead of
// refetching 50 messages every 3s; sig must change on new/edit/delete/reaction.

vi.mock("server-only", () => ({}));

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

const { msgCount, msgFindFirst, msgAggregate, reactionCount } = vi.hoisted(
  () => ({
    msgCount: vi.fn(),
    msgFindFirst: vi.fn(),
    msgAggregate: vi.fn(),
    reactionCount: vi.fn(),
  }),
);
vi.mock("@/lib/db", () => ({
  db: {
    globalChatMsg: {
      count: msgCount,
      findFirst: msgFindFirst,
      aggregate: msgAggregate,
    },
    globalChatReaction: { count: reactionCount },
  },
}));

import { GET } from "@/app/api/global-chat/version/route";

const T1 = new Date("2026-06-15T10:00:00.000Z");
const T2 = new Date("2026-06-15T11:00:00.000Z");

function setState(opts: {
  count: number;
  created?: Date | null;
  edited?: Date | null;
  reactions: number;
}) {
  msgCount.mockResolvedValue(opts.count);
  msgFindFirst.mockResolvedValue(
    opts.created === undefined
      ? { createdAt: T1 }
      : { createdAt: opts.created },
  );
  msgAggregate.mockResolvedValue({ _max: { editedAt: opts.edited ?? null } });
  reactionCount.mockResolvedValue(opts.reactions);
}

async function sig(): Promise<string> {
  const res = await GET();
  return (await res.json()).sig as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1" } });
});

describe("GET /api/global-chat/version", () => {
  it("unauthenticated → 401", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("composes the signature from count:created:edited:reactions", async () => {
    setState({ count: 5, created: T1, edited: null, reactions: 3 });
    expect(await sig()).toBe(`5:${T1.getTime()}:0:3`);
  });

  it("signature changes when a NEW message arrives (count + createdAt)", async () => {
    setState({ count: 5, created: T1, reactions: 0 });
    const a = await sig();
    setState({ count: 6, created: T2, reactions: 0 });
    expect(await sig()).not.toBe(a);
  });

  it("signature changes on an EDIT (max editedAt)", async () => {
    setState({ count: 5, created: T1, edited: null, reactions: 0 });
    const a = await sig();
    setState({ count: 5, created: T1, edited: T2, reactions: 0 });
    expect(await sig()).not.toBe(a);
  });

  it("signature changes on a REACTION (reaction count)", async () => {
    setState({ count: 5, created: T1, reactions: 3 });
    const a = await sig();
    setState({ count: 5, created: T1, reactions: 4 });
    expect(await sig()).not.toBe(a);
  });

  it("signature changes on a DELETE (count drops)", async () => {
    setState({ count: 6, created: T1, reactions: 0 });
    const a = await sig();
    setState({ count: 5, created: T1, reactions: 0 });
    expect(await sig()).not.toBe(a);
  });
});
