import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import {
  getTaskById,
  updateTask,
  deleteTask,
} from "@/lib/services/task.service";
import { updateTaskSchema } from "@/lib/schemas/task.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const task = await getTaskById(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(task);
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = updateTaskSchema.parse(body);

    const task = await updateTask(
      params.id,
      input,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(task);
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteTask(params.id, session.user.id, session.user.role);
    return new NextResponse(null, { status: 204 });
  });
}
