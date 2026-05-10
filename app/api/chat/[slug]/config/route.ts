import { NextResponse } from "next/server";
import { getPublicChatConfig } from "@/lib/services/chat/chat-config.service";
import { ApiError } from "@/lib/api-error";
import { withCors, corsResponse } from "@/lib/services/chat/cors";

export async function OPTIONS(request: Request) {
  return corsResponse(request.headers.get("origin"));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const config = await getPublicChatConfig(slug);

    const response = NextResponse.json(config);
    response.headers.set("Cache-Control", "public, max-age=300");
    return withCors(response, request.headers.get("origin"));
  } catch (err) {
    if (err instanceof ApiError) {
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        request.headers.get("origin"),
      );
    }
    console.error("[GET /api/chat/config]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      request.headers.get("origin"),
    );
  }
}
