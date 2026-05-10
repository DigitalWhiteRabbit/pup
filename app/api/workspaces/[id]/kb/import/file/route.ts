import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { importFromFile } from "@/lib/services/kb/import.service";
import { ApiError } from "@/lib/api-error";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workspaceId } = await params;
    const formData = await request.formData();

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "Файл обязателен" }, { status: 400 });
    }

    const categoryId = formData.get("categoryId") as string | null;
    const tagIdsRaw = formData.get("tagIds") as string | null;
    const tagIds = tagIdsRaw ? (JSON.parse(tagIdsRaw) as string[]) : undefined;

    const article = await importFromFile(
      {
        workspaceId,
        file,
        categoryId: categoryId ?? undefined,
        tagIds,
      },
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(article, { status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[POST /kb/import/file]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
