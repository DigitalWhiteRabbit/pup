import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { reorderCategories } from "@/lib/services/kb/category.service";
import { reorderCategoriesSchema } from "@/lib/schemas/kb.schema";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const { categoryIds } = reorderCategoriesSchema.parse(body);

    await reorderCategories(
      params.id,
      categoryIds,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json({ ok: true });
  });
}
