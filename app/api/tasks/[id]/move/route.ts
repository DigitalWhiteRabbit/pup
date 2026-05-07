import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { moveTask } from "@/lib/services/task.service";
import { moveTaskSchema } from "@/lib/schemas/task.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = moveTaskSchema.parse(body);

    const result = await moveTask(
      params.id,
      input.columnId,
      input.position,
      session.user.id,
      session.user.role,
    );

    return NextResponse.json(result);
  });
}
