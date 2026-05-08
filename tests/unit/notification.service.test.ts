import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only" to allow importing in test environment
vi.mock("server-only", () => ({}));

// Mock db
const mockCreate = vi.fn().mockResolvedValue({ id: "notif-1" });
const mockFindUnique = vi.fn();
const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
const mockCount = vi.fn().mockResolvedValue(0);
const mockFindMany = vi.fn().mockResolvedValue([]);
const mockTransaction = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    notification: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    task: {
      findUnique: vi.fn().mockResolvedValue({ title: "Test task" }),
    },
    project: {
      findUnique: vi.fn().mockResolvedValue({ name: "Test project" }),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Mock telegram sender
const mockSendTelegram = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/services/telegram/sender", () => ({
  sendTelegramNotification: (...args: unknown[]) => mockSendTelegram(...args),
  formatNotificationMessage: () => "Test message",
}));

import {
  notify,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
} from "@/lib/services/notification.service";

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
});

// ─── notify ───────────────────────────────────────────────────────────────────

describe("notify", () => {
  it("does nothing when actor === recipient (FR-029)", async () => {
    await notify({
      type: "ASSIGNED",
      recipientId: "user-1",
      actorId: "user-1",
      taskId: "task-1",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("creates in-app notification in DB", async () => {
    mockFindUnique.mockResolvedValue({ telegramChatId: null });

    await notify({
      type: "ASSIGNED",
      recipientId: "user-2",
      actorId: "user-1",
      taskId: "task-1",
      projectId: "proj-1",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "ASSIGNED",
        recipientId: "user-2",
        actorId: "user-1",
        taskId: "task-1",
        projectId: "proj-1",
      }),
    });
  });

  it("does not send Telegram when telegramChatId is null", async () => {
    mockFindUnique.mockResolvedValue({ telegramChatId: null });

    await notify({
      type: "ASSIGNED",
      recipientId: "user-2",
      actorId: "user-1",
    });

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("does not send Telegram when tgNotifyAssign is false for ASSIGNED", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: false,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
    });

    await notify({
      type: "ASSIGNED",
      recipientId: "user-2",
      actorId: "user-1",
    });

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("sends Telegram when tgNotifyAssign is true for ASSIGNED", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
      login: "actor",
    });

    await notify({
      type: "ASSIGNED",
      recipientId: "user-2",
      actorId: "user-1",
      taskId: "task-1",
      projectId: "proj-1",
    });

    // fire-and-forget, so we check it was called
    // Need to wait a tick for the void promise
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSendTelegram).toHaveBeenCalledWith("123", "Test message");
  });

  it("checks tgNotifyComment for COMMENTED type", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: true,
      tgNotifyComment: false,
      tgNotifyMove: true,
      tgNotifyProject: true,
    });

    await notify({
      type: "COMMENTED",
      recipientId: "user-2",
      actorId: "user-1",
    });

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("checks tgNotifyMove for MOVED type", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: false,
      tgNotifyProject: true,
    });

    await notify({
      type: "MOVED",
      recipientId: "user-2",
      actorId: "user-1",
    });

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("checks tgNotifyProject for PROJECT_ADDED type", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: false,
    });

    await notify({
      type: "PROJECT_ADDED",
      recipientId: "user-2",
      actorId: "user-1",
    });

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it("does not throw when sender throws (graceful degradation)", async () => {
    mockFindUnique.mockResolvedValue({
      telegramChatId: "123",
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
      login: "actor",
    });
    mockSendTelegram.mockRejectedValue(new Error("network error"));

    await expect(
      notify({
        type: "ASSIGNED",
        recipientId: "user-2",
        actorId: "user-1",
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── markAsRead ───────────────────────────────────────────────────────────────

describe("markAsRead", () => {
  it("marks own notifications by ids", async () => {
    await markAsRead(["n1", "n2"], "user-1");

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["n1", "n2"] },
        recipientId: "user-1",
      },
      data: { isRead: true },
    });
  });

  it("filters by recipientId to prevent marking others' notifications", async () => {
    await markAsRead(["n1"], "user-1");

    const call = mockUpdateMany.mock.calls[0]![0] as {
      where: { recipientId: string };
    };
    expect(call.where.recipientId).toBe("user-1");
  });
});

// ─── markAllAsRead ────────────────────────────────────────────────────────────

describe("markAllAsRead", () => {
  it("marks all unread for user", async () => {
    await markAllAsRead("user-1");

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { recipientId: "user-1", isRead: false },
      data: { isRead: true },
    });
  });
});

// ─── getUnreadCount ───────────────────────────────────────────────────────────

describe("getUnreadCount", () => {
  it("returns 0 when no unread", async () => {
    mockCount.mockResolvedValue(0);
    const count = await getUnreadCount("user-1");
    expect(count).toBe(0);
  });

  it("returns correct count for recipientId", async () => {
    mockCount.mockResolvedValue(5);
    const count = await getUnreadCount("user-1");
    expect(count).toBe(5);
    expect(mockCount).toHaveBeenCalledWith({
      where: { recipientId: "user-1", isRead: false },
    });
  });
});
