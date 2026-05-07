import "server-only";
import { isWorkColumn } from "@/lib/utils/columns";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// ─── Low-level interval operations ──────────────────────────────────────────

export async function openInterval(
  tx: Tx,
  taskId: string,
): Promise<{ id: string }> {
  return tx.timeInterval.create({ data: { taskId } });
}

export async function closeOpenIntervals(
  tx: Tx,
  taskId: string,
): Promise<number> {
  const result = await tx.timeInterval.updateMany({
    where: { taskId, endedAt: null },
    data: { endedAt: new Date() },
  });
  return result.count;
}

// ─── Batch operations (for column rename) ───────────────────────────────────

export async function openIntervalsForTasks(
  tx: Tx,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await tx.timeInterval.createMany({
    data: taskIds.map((taskId) => ({ taskId })),
  });
}

export async function closeIntervalsForTasks(
  tx: Tx,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await tx.timeInterval.updateMany({
    where: { taskId: { in: taskIds }, endedAt: null },
    data: { endedAt: new Date() },
  });
}

// ─── Pure calculation (no DB, no async) ─────────────────────────────────────

export function calcTimeFields(
  intervals: Array<{ startedAt: Date; endedAt: Date | null }>,
): {
  totalTimeMs: number;
  isInProgress: boolean;
  lastIntervalStartedAt: Date | null;
} {
  const now = Date.now();
  let totalTimeMs = 0;
  let isInProgress = false;
  let lastIntervalStartedAt: Date | null = null;

  for (const interval of intervals) {
    const end = interval.endedAt ? interval.endedAt.getTime() : now;
    totalTimeMs += end - interval.startedAt.getTime();
    if (!interval.endedAt) {
      isInProgress = true;
      lastIntervalStartedAt = interval.startedAt;
    }
  }

  return { totalTimeMs, isInProgress, lastIntervalStartedAt };
}

// ─── High-level: single task column transition ──────────────────────────────

export async function handleColumnTransition(
  tx: Tx,
  taskId: string,
  fromColumnName: string,
  toColumnName: string,
): Promise<"opened" | "closed" | "unchanged"> {
  const wasWork = isWorkColumn(fromColumnName);
  const willBeWork = isWorkColumn(toColumnName);

  if (wasWork && !willBeWork) {
    await closeOpenIntervals(tx, taskId);
    return "closed";
  }
  if (!wasWork && willBeWork) {
    await openInterval(tx, taskId);
    return "opened";
  }
  return "unchanged";
}

// ─── High-level: column rename (batch) ──────────────────────────────────────

export async function handleColumnRename(
  tx: Tx,
  columnId: string,
  oldName: string,
  newName: string,
): Promise<{ action: "opened" | "closed" | "unchanged"; taskCount: number }> {
  const wasWork = isWorkColumn(oldName);
  const willBeWork = isWorkColumn(newName);

  if (wasWork === willBeWork) {
    return { action: "unchanged", taskCount: 0 };
  }

  const tasks = await tx.task.findMany({
    where: { columnId },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);

  if (taskIds.length === 0) {
    return { action: wasWork ? "closed" : "opened", taskCount: 0 };
  }

  if (!wasWork && willBeWork) {
    await openIntervalsForTasks(tx, taskIds);
    return { action: "opened", taskCount: taskIds.length };
  }

  // wasWork && !willBeWork
  await closeIntervalsForTasks(tx, taskIds);
  return { action: "closed", taskCount: taskIds.length };
}
