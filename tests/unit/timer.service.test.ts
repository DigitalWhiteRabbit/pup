import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only" to allow importing in test environment
vi.mock("server-only", () => ({}));

import {
  calcTimeFields,
  openInterval,
  handleColumnTransition,
  handleColumnRename,
} from "@/lib/services/timer.service";

// ─── Mock transaction builder ───────────────────────────────────────────────

function createMockTx() {
  return {
    timeInterval: {
      create: vi.fn().mockResolvedValue({ id: "interval-1" }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    task: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as Parameters<typeof openInterval>[0];
}

// ─── calcTimeFields ─────────────────────────────────────────────────────────

describe("calcTimeFields", () => {
  it("returns zeros for empty intervals array", () => {
    const result = calcTimeFields([]);
    expect(result).toEqual({
      totalTimeMs: 0,
      isInProgress: false,
      lastIntervalStartedAt: null,
    });
  });

  it("calculates single closed interval of 30s", () => {
    const start = new Date("2026-05-07T10:00:00Z");
    const end = new Date("2026-05-07T10:00:30Z");
    const result = calcTimeFields([{ startedAt: start, endedAt: end }]);
    expect(result.totalTimeMs).toBe(30000);
    expect(result.isInProgress).toBe(false);
    expect(result.lastIntervalStartedAt).toBeNull();
  });

  it("calculates single open interval started 10s ago", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-07T12:00:00Z");
    vi.setSystemTime(now);

    const start = new Date("2026-05-07T11:59:50Z"); // 10s ago
    const result = calcTimeFields([{ startedAt: start, endedAt: null }]);

    expect(result.totalTimeMs).toBe(10000);
    expect(result.isInProgress).toBe(true);
    expect(result.lastIntervalStartedAt).toEqual(start);

    vi.useRealTimers();
  });

  it("sums multiple closed intervals", () => {
    const intervals = [
      {
        startedAt: new Date("2026-05-07T10:00:00Z"),
        endedAt: new Date("2026-05-07T10:00:15Z"), // 15s
      },
      {
        startedAt: new Date("2026-05-07T11:00:00Z"),
        endedAt: new Date("2026-05-07T11:00:25Z"), // 25s
      },
      {
        startedAt: new Date("2026-05-07T12:00:00Z"),
        endedAt: new Date("2026-05-07T12:00:10Z"), // 10s
      },
    ];
    const result = calcTimeFields(intervals);
    expect(result.totalTimeMs).toBe(50000);
    expect(result.isInProgress).toBe(false);
  });

  it("handles mixed closed + open intervals", () => {
    vi.useFakeTimers();
    const now = new Date("2026-05-07T14:00:00Z");
    vi.setSystemTime(now);

    const openStart = new Date("2026-05-07T13:59:50Z"); // 10s ago
    const intervals = [
      {
        startedAt: new Date("2026-05-07T10:00:00Z"),
        endedAt: new Date("2026-05-07T10:00:20Z"), // 20s
      },
      {
        startedAt: new Date("2026-05-07T11:00:00Z"),
        endedAt: new Date("2026-05-07T11:00:30Z"), // 30s
      },
      { startedAt: openStart, endedAt: null }, // 10s open
    ];
    const result = calcTimeFields(intervals);
    expect(result.totalTimeMs).toBe(60000); // 20+30+10
    expect(result.isInProgress).toBe(true);
    expect(result.lastIntervalStartedAt).toEqual(openStart);

    vi.useRealTimers();
  });
});

// ─── handleColumnTransition ─────────────────────────────────────────────────

describe("handleColumnTransition", () => {
  let tx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    tx = createMockTx();
  });

  it("returns 'unchanged' for non-work → non-work", async () => {
    const result = await handleColumnTransition(
      tx,
      "task-1",
      "Ожидает",
      "Готово",
    );
    expect(result).toBe("unchanged");
    expect(tx.timeInterval.create).not.toHaveBeenCalled();
    expect(tx.timeInterval.updateMany).not.toHaveBeenCalled();
  });

  it("opens interval for non-work → work", async () => {
    const result = await handleColumnTransition(
      tx,
      "task-1",
      "Ожидает",
      "В работе",
    );
    expect(result).toBe("opened");
    expect(tx.timeInterval.create).toHaveBeenCalledWith({
      data: { taskId: "task-1" },
    });
  });

  it("closes intervals for work → non-work", async () => {
    (tx.timeInterval.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });
    const result = await handleColumnTransition(
      tx,
      "task-1",
      "В работе",
      "Готово",
    );
    expect(result).toBe("closed");
    expect(tx.timeInterval.updateMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", endedAt: null },
      data: { endedAt: expect.any(Date) },
    });
  });

  it("returns 'unchanged' for work → work", async () => {
    const result = await handleColumnTransition(
      tx,
      "task-1",
      "В работе",
      "в работе",
    );
    expect(result).toBe("unchanged");
  });

  it("handles case-insensitive column names", async () => {
    const cases = ["В РАБОТЕ", "в работе", " В Работе "];
    for (const name of cases) {
      const freshTx = createMockTx();
      const result = await handleColumnTransition(
        freshTx,
        "task-1",
        "Backlog",
        name,
      );
      expect(result).toBe("opened");
    }
  });
});

// ─── handleColumnRename ─────────────────────────────────────────────────────

describe("handleColumnRename", () => {
  let tx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    tx = createMockTx();
  });

  it("returns unchanged for non-work → non-work rename", async () => {
    const result = await handleColumnRename(tx, "col-1", "TODO", "Done");
    expect(result).toEqual({ action: "unchanged", taskCount: 0 });
    expect(tx.task.findMany).not.toHaveBeenCalled();
  });

  it("opens intervals for all tasks when renamed to 'В работе'", async () => {
    (tx.task.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ]);

    const result = await handleColumnRename(tx, "col-1", "Backlog", "В работе");
    expect(result).toEqual({ action: "opened", taskCount: 3 });
    expect(tx.timeInterval.createMany).toHaveBeenCalledWith({
      data: [{ taskId: "t1" }, { taskId: "t2" }, { taskId: "t3" }],
    });
  });

  it("closes intervals for all tasks when renamed from 'В работе'", async () => {
    (tx.task.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
      { id: "t4" },
      { id: "t5" },
    ]);

    const result = await handleColumnRename(
      tx,
      "col-1",
      "В работе",
      "Завершено",
    );
    expect(result).toEqual({ action: "closed", taskCount: 5 });
    expect(tx.timeInterval.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: { in: ["t1", "t2", "t3", "t4", "t5"] },
        endedAt: null,
      },
      data: { endedAt: expect.any(Date) },
    });
  });

  it("handles empty column (no tasks)", async () => {
    (tx.task.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await handleColumnRename(tx, "col-1", "Backlog", "В работе");
    expect(result).toEqual({ action: "opened", taskCount: 0 });
    expect(tx.timeInterval.createMany).not.toHaveBeenCalled();
  });
});
