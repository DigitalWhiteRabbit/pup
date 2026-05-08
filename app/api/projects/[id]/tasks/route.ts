import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { createTask } from "@/lib/services/task.service";
import { createTaskSchema } from "@/lib/schemas/task.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = createTaskSchema.parse(body);

    const task = await createTask(
      {
        title: input.title,
        description: input.description ?? null,
        columnId: input.columnId,
        assigneeIds: input.assigneeIds,
        priority: input.priority,
        projectId: params.id,
      },
      session.user.id,
      session.user.role,
    );

    return NextResponse.json(task, { status: 201 });
  });
}
