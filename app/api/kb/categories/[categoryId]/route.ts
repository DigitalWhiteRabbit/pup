import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  updateCategory,
  deleteCategory,
} from "@/lib/services/kb/category.service";
import { updateCategorySchema } from "@/lib/schemas/kb.schema";

type Params = { params: { categoryId: string } };

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

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

    await deleteCategory(params.categoryId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
