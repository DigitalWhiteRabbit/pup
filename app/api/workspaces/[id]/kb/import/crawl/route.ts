import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { startCrawl } from "@/lib/services/kb/crawler.service";
import { ApiError } from "@/lib/api-error";
import { z } from "zod";

const schema = z.object({
  startUrl: z.string().url("Некорректный URL"),
  maxPages: z.number().int().min(1).max(10000).optional(),
  maxDepth: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(60000).max(3600000).optional(),
  categoryId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  // Path prefixes to skip during the crawl (e.g. ["/de","/fr"]) — used to
  // exclude unwanted locales/sections. Plain strings (segment-prefix match in
  // the crawler), not regex; bounded to avoid abuse.
  excludePaths: z.array(z.string().max(200)).max(100).optional(),
});

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
    const body: unknown = await request.json();
    const validated = schema.parse(body);

    const result = await startCrawl(
      { workspaceId, ...validated },
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(result, { status: 201 });
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
    console.error("[POST /kb/import/crawl]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
