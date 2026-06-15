import { describe, it, expect, vi, beforeEach } from "vitest";

// Light dashboard aggregates (P1-C): same numbers the old full-board UI derived,
// computed server-side; membership-gated.

vi.mock("server-only", () => ({}));

const { checkMembership } = vi.hoisted(() => ({ checkMembership: vi.fn() }));
vi.mock("@/lib/services/membership-check", () => ({ checkMembership }));

const { columnFindMany, taskCount, taskFindMany } = vi.hoisted(() => ({
  columnFindMany: vi.fn(),
  taskCount: vi.fn(),
  taskFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    column: { findMany: columnFindMany },
    task: { count: taskCount, findMany: taskFindMany },
  },
}));

import {
  getDashboardStats,
  isDoneColumnName,
} from "@/lib/services/dashboard.service";

beforeEach(() => {
  vi.clearAllMocks();
  checkMembership.mockResolvedValue("MEMBER");
  columnFindMany.mockResolvedValue([
    { id: "c1", name: "Ожидает", position: 0, _count: { tasks: 3 } },
    { id: "c2", name: "В работе", position: 1, _count: { tasks: 2 } },
    { id: "c3", name: "Готово", position: 2, _count: { tasks: 5 } },
  ]);
  // Promise.all order: [inProgressCount, myTasksCount, myTaskRows]
  taskCount.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  taskFindMany.mockResolvedValue([
    { id: "t1", title: "Моя 1", column: { name: "Ожидает" } },
    { id: "t2", title: "Моя 2", column: { name: "В работе" } },
  ]);
});

describe("getDashboardStats", () => {
  it("aggregates match the board-derived numbers", async () => {
    const s = await getDashboardStats("w1", "u1", "USER");
    expect(s.totalTasks).toBe(10); // 3+2+5
    expect(s.doneCount).toBe(5); // "Готово" column
    expect(s.inProgressCount).toBe(1); // open time interval
    expect(s.myTasksCount).toBe(2);
    expect(s.myTasks.map((t) => t.title)).toEqual(["Моя 1", "Моя 2"]);
    expect(s.columns).toHaveLength(3);
    expect(s.columns[2]).toMatchObject({ name: "Готово", taskCount: 5 });
  });

  it("my-tasks query excludes done columns", async () => {
    await getDashboardStats("w1", "u1", "USER");
    // both task.count(myTasks) and task.findMany filter out the done column id
    const findArgs = taskFindMany.mock.calls[0]![0] as {
      where: { columnId?: { notIn: string[] } };
    };
    expect(findArgs.where.columnId).toEqual({ notIn: ["c3"] });
  });

  it("non-member non-admin → 403", async () => {
    checkMembership.mockResolvedValue(null);
    await expect(getDashboardStats("w1", "u1", "USER")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("ADMIN non-member is allowed", async () => {
    checkMembership.mockResolvedValue(null);
    const s = await getDashboardStats("w1", "admin", "ADMIN");
    expect(s.totalTasks).toBe(10);
  });
});

describe("isDoneColumnName", () => {
  it("matches done-column names (ru/en), not others", () => {
    expect(isDoneColumnName("Готово")).toBe(true);
    expect(isDoneColumnName("Done")).toBe(true);
    expect(isDoneColumnName("Завершено")).toBe(true);
    expect(isDoneColumnName("В работе")).toBe(false);
    expect(isDoneColumnName("Ожидает")).toBe(false);
  });
});
