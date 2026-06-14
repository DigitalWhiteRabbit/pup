import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { createTask } from "@/lib/services/task.service";
import { createTaskSchema } from "@/lib/schemas/task.schema";
import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
  ServiceRateLimitError,
} from "@/lib/middleware/resolve-auth";
import { checkMembership } from "@/lib/services/membership-check";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: { id: string } };

/** GET — List all tasks in workspace (flat, with column name, assignees, labels) */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const ctx = await resolveAuth(req);
    if (!ctx)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    requireScope(ctx, "tasks:read");
    requireWorkspace(ctx, params.id);

    // Cross-tenant IDOR guard: requireScope/requireWorkspace are no-ops for
    // user sessions, and this route had NO membership check (unlike its
    // siblings). A logged-in non-member could read any workspace's tasks by
    // changing the id. Enforce membership; ADMIN bypass kept for parity with
    // the other internal /api/workspaces/[id]/* routes.
    if (ctx.type === "user" && ctx.role !== "ADMIN") {
      const role = await checkMembership(params.id, ctx.id);
      if (!role)
        throw new ApiError("Доступ запрещён", "WORKSPACE_FORBIDDEN", 403);
    }

    await requireWorkspaceAccess(ctx, params.id, { module: "crm" });

    const tasks = await db.task.findMany({
      where: { workspaceId: params.id },
      orderBy: [{ column: { position: "asc" } }, { position: "asc" }],
      include: {
        column: { select: { id: true, name: true } },
        assignees: {
          include: {
            user: { select: { id: true, login: true } },
          },
        },
        labels: { include: { label: true } },
        checklistItems: { select: { checked: true } },
      },
    });

    const result = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      position: t.position,
      columnId: t.column.id,
      columnName: t.column.name,
      startDate: t.startDate,
      dueDate: t.dueDate,
      assignees: t.assignees.map((a) => a.user),
      labels: t.labels.map((tl) => tl.label),
      checklistTotal: t.checklistItems.length,
      checklistDone: t.checklistItems.filter((i) => i.checked).length,
      createdAt: t.createdAt,
    }));

    return NextResponse.json({ data: result, total: result.length });
  } catch (err) {
    if (err instanceof ServiceRateLimitError) return err.toResponse();
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /tasks]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);
    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "crm",
    });

    const body: unknown = await req.json();
    const input = createTaskSchema.parse(body);

    const task = await createTask(
      {
        title: input.title,
        description: input.description ?? null,
        columnId: input.columnId,
        assigneeIds: input.assigneeIds,
        priority: input.priority,
        workspaceId: params.id,
      },
      session.user.id,
      session.user.role,
    );

    return NextResponse.json(task, { status: 201 });
  });
}
