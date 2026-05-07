import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { reorderTask } from "@/lib/services/task.service";
import { reorderTaskSchema } from "@/lib/schemas/task.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = reorderTaskSchema.parse(body);

    const result = await reorderTask(
      params.id,
      input.position,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(result);
  });
}
