import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./membership-check";

/** Done-column name heuristic — mirrors isDoneColumn in WorkspaceDashboard.tsx. */
export function isDoneColumnName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("готов") ||
    n.includes("done") ||
    n.includes("завершен") ||
    n.includes("complete")
  );
}

export type DashboardStats = {
  totalTasks: number;
  inProgressCount: number;
  doneCount: number;
  myTasksCount: number;
  columns: { id: string; name: string; position: number; taskCount: number }[];
  /** Capped list for the "Мои задачи" panel (full count is myTasksCount). */
  myTasks: { id: string; title: string; columnName: string }[];
};

const MY_TASKS_LIMIT = 50;

/**
 * Lightweight dashboard aggregates — replaces fetching the entire board
 * (columns+tasks+assignees+labels+checklists, ~hundreds of KB) every 5s just to
 * render a few counts + a short my-tasks list. Returns only counts, per-column
 * task counts, and a capped my-tasks list.
 *
 * Numbers match the old board-derived UI EXACTLY for total/done/my-tasks. The
 * in-progress count is now computed correctly (a task with an OPEN time interval)
 * — the board hardcoded isInProgress=false, so the dashboard's "В работе сейчас"
 * was previously always 0.
 */
export async function getDashboardStats(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<DashboardStats> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const columns = await db.column.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      name: true,
      position: true,
      _count: { select: { tasks: true } },
    },
  });

  const doneColumnIds = columns
    .filter((c) => isDoneColumnName(c.name))
    .map((c) => c.id);

  const totalTasks = columns.reduce((s, c) => s + c._count.tasks, 0);
  const doneCount = columns
    .filter((c) => doneColumnIds.includes(c.id))
    .reduce((s, c) => s + c._count.tasks, 0);

  const myTasksWhere = {
    workspaceId,
    assignees: { some: { userId } },
    ...(doneColumnIds.length ? { columnId: { notIn: doneColumnIds } } : {}),
  };

  const [inProgressCount, myTasksCount, myTaskRows] = await Promise.all([
    db.task.count({
      where: { workspaceId, timeIntervals: { some: { endedAt: null } } },
    }),
    db.task.count({ where: myTasksWhere }),
    db.task.findMany({
      where: myTasksWhere,
      orderBy: { position: "asc" },
      take: MY_TASKS_LIMIT,
      select: { id: true, title: true, column: { select: { name: true } } },
    }),
  ]);

  return {
    totalTasks,
    inProgressCount,
    doneCount,
    myTasksCount,
    columns: columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      taskCount: c._count.tasks,
    })),
    myTasks: myTaskRows.map((t) => ({
      id: t.id,
      title: t.title,
      columnName: t.column.name,
    })),
  };
}
