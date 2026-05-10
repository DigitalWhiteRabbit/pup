import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { importFromUrl } from "@/lib/services/kb/import.service";
import { parseUrl } from "@/lib/services/kb/url-parser.service";
import { ApiError } from "@/lib/api-error";
import { z } from "zod";

const importSchema = z.object({
  url: z.string().url("Некорректный URL"),
  categoryId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
});

const previewSchema = z.object({
  url: z.string().url("Некорректный URL"),
});

// POST /api/workspaces/[id]/kb/import/url — import from URL
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

    // Check if this is a preview request
    const url = new URL(request.url);
    if (url.pathname.endsWith("/preview")) {
      const body: unknown = await request.json();
      const parsed = previewSchema.parse(body);
      const result = await parseUrl(parsed.url);
      return NextResponse.json({
        title: result.title,
        content: result.content,
        finalUrl: result.finalUrl,
        metadata: result.metadata,
      });
    }

    const body: unknown = await request.json();
    const validated = importSchema.parse(body);

    const article = await importFromUrl(
      {
        workspaceId,
        url: validated.url,
        categoryId: validated.categoryId,
        tagIds: validated.tagIds,
      },
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(article, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[POST /kb/import/url]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
