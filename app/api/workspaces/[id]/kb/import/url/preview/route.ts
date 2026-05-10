import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { parseUrl } from "@/lib/services/kb/url-parser.service";
import { ApiError } from "@/lib/api-error";
import { z } from "zod";

const schema = z.object({
  url: z.string().url("Некорректный URL"),
});

export async function POST(
  request: Request,
  { params: _params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: unknown = await request.json();
    const { url } = schema.parse(body);

    const result = await parseUrl(url);

    return NextResponse.json({
      title: result.title,
      content: result.content,
      finalUrl: result.finalUrl,
      metadata: result.metadata,
    });
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
    console.error("[POST /kb/import/url/preview]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
