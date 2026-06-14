import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { reorderColumn } from "@/lib/services/column.service";
import { reorderColumnSchema } from "@/lib/schemas/column.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.column.findUnique({
      where: { id: params.id },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "crm",
      },
    );

    const body: unknown = await req.json();
    const input = reorderColumnSchema.parse(body);

    const result = await reorderColumn(
      params.id,
      input.position,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(result);
  });
}
