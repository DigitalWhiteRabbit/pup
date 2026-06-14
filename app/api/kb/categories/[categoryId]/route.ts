import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import {
  updateCategory,
  deleteCategory,
} from "@/lib/services/kb/category.service";
import { updateCategorySchema } from "@/lib/schemas/kb.schema";

type Params = { params: { categoryId: string } };

async function requireCategoryAccess(
  session: { user: { id: string; role?: string | null } },
  categoryId: string,
): Promise<void> {
  const ent = await db.kbCategory.findUnique({
    where: { id: categoryId },
    select: { workspaceId: true },
  });
  if (!ent) throw new ApiError("Категория не найдена", "NOT_FOUND", 404);
  await requireWorkspaceAccess(accessCtxFromSession(session), ent.workspaceId, {
    module: "knowledge",
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireCategoryAccess(session, params.categoryId);

    const body: unknown = await req.json();
    const data = updateCategorySchema.parse(body);

    const cat = await updateCategory(
      params.categoryId,
      data,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(cat);
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireCategoryAccess(session, params.categoryId);

    await deleteCategory(params.categoryId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
