import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { renameColumn, deleteColumn } from "@/lib/services/project.service";
import { updateColumnSchema } from "@/lib/schemas/column.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = updateColumnSchema.parse(body);

    const column = await renameColumn(
      params.id,
      input.name,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(column);
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteColumn(params.id, session.user.id, session.user.role);
    return new NextResponse(null, { status: 204 });
  });
}
