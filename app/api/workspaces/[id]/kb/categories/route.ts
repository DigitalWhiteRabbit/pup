import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  listCategories,
  createCategory,
} from "@/lib/services/kb/category.service";
import { createCategorySchema } from "@/lib/schemas/kb.schema";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const cats = await listCategories(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(cats);
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const data = createCategorySchema.parse(body);

    const cat = await createCategory(
      params.id,
      data,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(cat, { status: 201 });
  });
}
