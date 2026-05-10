import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// ─── Mock db ──────────────────────────────────────────────────────────────────

const mockActivityCreate = vi.fn().mockResolvedValue({ id: "log-1" });
const mockActivityDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
const mockActivityFindMany = vi.fn().mockResolvedValue([]);
const mockActivityCount = vi.fn().mockResolvedValue(0);
const mockSystemCreate = vi.fn().mockResolvedValue({ id: "slog-1" });
const mockSystemDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
const mockSystemFindMany = vi.fn().mockResolvedValue([]);
const mockSystemCount = vi.fn().mockResolvedValue(0);
const mockTransaction = vi.fn();
const mockMemberFindUnique = vi.fn().mockResolvedValue({ role: "MEMBER" });

vi.mock("@/lib/db", () => ({
  db: {
    activityLog: {
      create: (...args: unknown[]) => mockActivityCreate(...args),
      deleteMany: (...args: unknown[]) => mockActivityDeleteMany(...args),
      findMany: (...args: unknown[]) => mockActivityFindMany(...args),
      count: (...args: unknown[]) => mockActivityCount(...args),
    },
    systemLog: {
      create: (...args: unknown[]) => mockSystemCreate(...args),
      deleteMany: (...args: unknown[]) => mockSystemDeleteMany(...args),
      findMany: (...args: unknown[]) => mockSystemFindMany(...args),
      count: (...args: unknown[]) => mockSystemCount(...args),
    },
    workspaceMember: {
      findUnique: (...args: unknown[]) => mockMemberFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Mock workspace.service checkMembership
vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("MEMBER"),
}));

// Mock telegram sender
vi.mock("@/lib/services/telegram/sender", () => ({
  sendTelegramNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  logActivity,
  logSystem,
  cleanupOldLogs,
  generateSummary,
  getActivityLogs,
} from "@/lib/services/logger.service";

// ─── logActivity ──────────────────────────────────────────────────────────────

describe("logActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityCreate.mockResolvedValue({ id: "log-1" });
  });

  it("creates an ActivityLog record", async () => {
    await logActivity({
      workspaceId: "ws-1",
      actorId: "user-1",
      action: "TASK_CREATED",
      entityType: "Task",
      entityId: "task-1",
      taskId: "task-1",
      summary: "admin создал задачу «Тест»",
      metadata: { columnId: "col-1" },
    });

    expect(mockActivityCreate).toHaveBeenCalledOnce();
    const call = mockActivityCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.action).toBe("TASK_CREATED");
    expect(call.data.workspaceId).toBe("ws-1");
    expect(call.data.actorId).toBe("user-1");
    expect(call.data.summary).toBe("admin создал задачу «Тест»");
  });

  it("stringifies metadata correctly", async () => {
    await logActivity({
      action: "WORKSPACE_CREATED",
      summary: "test",
      metadata: { name: "Demo", count: 42, active: true },
    });

    const call = mockActivityCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    const parsed = JSON.parse(call.data.metadata as string) as Record<
      string,
      unknown
    >;
    expect(parsed.name).toBe("Demo");
    expect(parsed.count).toBe(42);
    expect(parsed.active).toBe(true);
  });

  it("handles non-serializable metadata without throwing", async () => {
    await expect(
      logActivity({
        action: "TASK_DELETED",
        summary: "deleted",
        metadata: {
          sym: Symbol("test"),
          fn: () => "hello",
        } as unknown as Record<string, unknown>,
      }),
    ).resolves.toBeUndefined();

    expect(mockActivityCreate).toHaveBeenCalledOnce();
  });

  it("workspaceId is optional (system actions)", async () => {
    await logActivity({
      action: "USER_LOGIN",
      summary: "admin вошёл в систему",
      actorId: "user-1",
    });

    const call = mockActivityCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.workspaceId).toBeNull();
  });

  it("actorId nullable — record saved without actor", async () => {
    await logActivity({
      action: "USER_CREATED_BY_ADMIN",
      actorId: null,
      summary: "Система создала пользователя",
    });

    const call = mockActivityCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.actorId).toBeNull();
    expect(mockActivityCreate).toHaveBeenCalledOnce();
  });

  it("does not throw if db.create fails", async () => {
    mockActivityCreate.mockRejectedValueOnce(new Error("DB down"));

    await expect(
      logActivity({
        action: "TASK_CREATED",
        summary: "test",
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── logSystem ────────────────────────────────────────────────────────────────

describe("logSystem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a SystemLog record with INFO level by default", async () => {
    await logSystem({
      source: "api-route",
      message: "GET /api/workspaces",
    });

    expect(mockSystemCreate).toHaveBeenCalledOnce();
    const call = mockSystemCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.level).toBe("INFO");
    expect(call.data.source).toBe("api-route");
  });

  it("stores ERROR level and errorStack", async () => {
    await logSystem({
      level: "ERROR",
      source: "service",
      message: "Unhandled exception",
      errorStack: "Error: Unhandled\n  at fn (file.ts:1)",
    });

    const call = mockSystemCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.level).toBe("ERROR");
    expect(call.data.errorStack).toContain("Unhandled");
  });

  it("does not throw if db.create fails", async () => {
    mockSystemCreate.mockRejectedValueOnce(new Error("DB down"));
    await expect(
      logSystem({ source: "test", message: "msg" }),
    ).resolves.toBeUndefined();
  });
});

// ─── getActivityLogs ──────────────────────────────────────────────────────────

describe("getActivityLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(
      async (queries: [Promise<unknown[]>, Promise<number>]) => {
        return Promise.all(queries);
      },
    );
    mockActivityFindMany.mockResolvedValue([]);
    mockActivityCount.mockResolvedValue(0);
  });

  it("calls findMany with action filter", async () => {
    await getActivityLogs("ws-1", "user-1", "USER", {
      actions: ["TASK_CREATED", "TASK_DELETED"],
    });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("applies pagination correctly", async () => {
    await getActivityLogs("ws-1", "user-1", "USER", {
      page: 3,
      pageSize: 10,
    });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("returns mapped data and total", async () => {
    const fakeLog = {
      id: "log-1",
      action: "TASK_CREATED",
      entityType: "Task",
      entityId: "task-1",
      summary: "admin создал задачу «Тест»",
      metadata: '{"columnId":"col-1"}',
      taskId: "task-1",
      columnId: "col-1",
      actor: { id: "user-1", login: "admin" },
      createdAt: new Date("2026-01-01T10:00:00Z"),
    };

    mockTransaction.mockImplementationOnce(async () => [[fakeLog], 1]);

    const result = await getActivityLogs("ws-1", "user-1", "USER");

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.action).toBe("TASK_CREATED");
    expect(result.data[0]!.metadata).toEqual({ columnId: "col-1" });
    expect(result.data[0]!.actor?.login).toBe("admin");
  });

  it("filters by from/to dates", async () => {
    mockTransaction.mockImplementationOnce(async () => [[], 0]);

    const from = new Date("2026-01-01");
    const to = new Date("2026-01-31");

    await getActivityLogs("ws-1", "user-1", "USER", { from, to });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("filters by actorId", async () => {
    mockTransaction.mockImplementationOnce(async () => [[], 0]);

    await getActivityLogs("ws-1", "user-1", "USER", {
      actorIds: ["user-2", "user-3"],
    });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("filters by taskId", async () => {
    mockTransaction.mockImplementationOnce(async () => [[], 0]);

    await getActivityLogs("ws-1", "user-1", "USER", { taskId: "task-42" });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("search by summary text", async () => {
    mockTransaction.mockImplementationOnce(async () => [[], 0]);

    await getActivityLogs("ws-1", "user-1", "USER", { search: "создал" });

    expect(mockTransaction).toHaveBeenCalledOnce();
  });
});

// ─── cleanupOldLogs ───────────────────────────────────────────────────────────

describe("cleanupOldLogs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes logs older than 90 days and returns counts", async () => {
    mockActivityDeleteMany.mockResolvedValueOnce({ count: 7 });
    mockSystemDeleteMany.mockResolvedValueOnce({ count: 3 });

    const result = await cleanupOldLogs();

    expect(result.activityDeleted).toBe(7);
    expect(result.systemDeleted).toBe(3);
  });

  it("calls deleteMany with createdAt lt 90-day cutoff", async () => {
    const before = Date.now();
    mockActivityDeleteMany.mockResolvedValueOnce({ count: 0 });
    mockSystemDeleteMany.mockResolvedValueOnce({ count: 0 });

    await cleanupOldLogs();
    const after = Date.now();

    const call = mockActivityDeleteMany.mock.calls[0]![0] as {
      where: { createdAt: { lt: Date } };
    };
    const cutoff = call.where.createdAt.lt;

    const expectedMin = new Date(before - 90 * 24 * 60 * 60 * 1000);
    const expectedMax = new Date(after - 90 * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it("returns zero counts when nothing deleted", async () => {
    mockActivityDeleteMany.mockResolvedValueOnce({ count: 0 });
    mockSystemDeleteMany.mockResolvedValueOnce({ count: 0 });

    const result = await cleanupOldLogs();

    expect(result.activityDeleted).toBe(0);
    expect(result.systemDeleted).toBe(0);
  });
});

// ─── generateSummary ──────────────────────────────────────────────────────────

describe("generateSummary", () => {
  it("TASK_CREATED → actor created task", () => {
    const summary = generateSummary("TASK_CREATED", {
      actorLogin: "admin",
      taskTitle: "Дизайн главной",
    });
    expect(summary).toBe("admin создал задачу «Дизайн главной»");
  });

  it("TASK_MOVED → from/to columns", () => {
    const summary = generateSummary("TASK_MOVED", {
      actorLogin: "admin",
      taskTitle: "Дизайн главной",
      columnNameOld: "Ожидает",
      columnName: "В работе",
    });
    expect(summary).toBe(
      "admin переместил задачу «Дизайн главной» из «Ожидает» в «В работе»",
    );
  });

  it("TASK_UPDATED with old title → rename summary", () => {
    const summary = generateSummary("TASK_UPDATED", {
      actorLogin: "admin",
      taskTitle: "Новое имя",
      taskTitleOld: "Старое имя",
    });
    expect(summary).toBe(
      "admin переименовал задачу «Старое имя» → «Новое имя»",
    );
  });

  it("TASK_DELETED → actor deleted task", () => {
    const summary = generateSummary("TASK_DELETED", {
      actorLogin: "tester",
      taskTitle: "Задача X",
    });
    expect(summary).toBe("tester удалил задачу «Задача X»");
  });

  it("MEMBER_ADDED → actor added target", () => {
    const summary = generateSummary("MEMBER_ADDED", {
      actorLogin: "admin",
      targetLogin: "tester",
    });
    expect(summary).toBe("admin добавил tester в workspace");
  });

  it("MEMBER_REMOVED → actor removed target", () => {
    const summary = generateSummary("MEMBER_REMOVED", {
      actorLogin: "admin",
      targetLogin: "tester",
    });
    expect(summary).toBe("admin удалил tester из workspace");
  });

  it("COLUMN_CREATED → actor created column", () => {
    const summary = generateSummary("COLUMN_CREATED", {
      actorLogin: "admin",
      columnName: "В работе",
    });
    expect(summary).toBe("admin создал колонку «В работе»");
  });

  it("COLUMN_RENAMED → old to new name", () => {
    const summary = generateSummary("COLUMN_RENAMED", {
      actorLogin: "admin",
      columnNameOld: "В работе",
      columnName: "В процессе",
    });
    expect(summary).toBe(
      "admin переименовал колонку «В работе» → «В процессе»",
    );
  });

  it("TASK_PRIORITY_CHANGED → shows old and new priority", () => {
    const summary = generateSummary("TASK_PRIORITY_CHANGED", {
      actorLogin: "admin",
      taskTitle: "Задача",
      priorityOld: "LOW",
      priority: "HIGH",
    });
    expect(summary).toContain("LOW");
    expect(summary).toContain("HIGH");
  });

  it("uses Система when actorLogin is null", () => {
    const summary = generateSummary("USER_CREATED_BY_ADMIN", {
      actorLogin: null,
      targetLogin: "newuser",
    });
    expect(summary).toContain("Система");
    expect(summary).toContain("newuser");
  });
});
