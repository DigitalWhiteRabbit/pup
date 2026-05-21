import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/tasks
 * Scope: tasks:read
 *
 * All columns with their tasks, assignees, labels, and checklist progress.
 */
export const GET = withServiceAuth("tasks:read", async (_req, workspaceId) => {
  const columns = await db.column.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      name: true,
      position: true,
      tasks: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          title: true,
          description: true,
          priority: true,
          position: true,
          startDate: true,
          dueDate: true,
          createdAt: true,
          assignees: {
            select: {
              user: { select: { id: true, login: true } },
            },
          },
          labels: {
            select: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
          checklistItems: {
            select: { checked: true },
          },
        },
      },
    },
  });

  const data = columns.map((col) => ({
    id: col.id,
    name: col.name,
    position: col.position,
    tasks: col.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      position: t.position,
      startDate: t.startDate,
      dueDate: t.dueDate,
      createdAt: t.createdAt,
      assignees: t.assignees.map((a) => a.user),
      labels: t.labels.map((tl) => tl.label),
      checklistTotal: t.checklistItems.length,
      checklistDone: t.checklistItems.filter((i) => i.checked).length,
    })),
  }));

  const totalTasks = data.reduce((s, c) => s + c.tasks.length, 0);

  return NextResponse.json({
    data,
    totalColumns: data.length,
    totalTasks,
  });
});
