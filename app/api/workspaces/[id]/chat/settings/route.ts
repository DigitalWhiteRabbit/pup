import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import { updateChatSettings } from "@/lib/services/chat/chat-config.service";
import { checkMembership } from "@/lib/services/workspace.service";
import { db } from "@/lib/db";

const updateSchema = z.object({
  chatTitle: z.string().max(200).nullable().optional(),
  chatSubtitle: z.string().max(500).nullable().optional(),
  chatAccentColor: z.string().max(7).nullable().optional(),
  chatLogoUrl: z.string().max(500).nullable().optional(),
  chatIdentityMethod: z
    .enum(["EMAIL_WITH_NAME", "EMAIL_ONLY", "ANONYMOUS", "TELEGRAM_LOGIN"])
    .optional(),
  chatPersonaRotation: z.boolean().optional(),
  chatAllowedEmbedOrigins: z.string().nullable().optional(),
  chatTimezone: z.string().max(100).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        slug: true,
        chatTitle: true,
        chatSubtitle: true,
        chatAccentColor: true,
        chatLogoUrl: true,
        chatIdentityMethod: true,
        chatPersonaRotation: true,
        chatAllowedEmbedOrigins: true,
        chatTimezone: true,
      },
    });
    if (!workspace) {
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    }

    return NextResponse.json(workspace);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /chat/settings]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    const body: unknown = await request.json();
    const validated = updateSchema.parse(body);

    await updateChatSettings(
      workspaceId,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    }
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[PATCH /chat/settings]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
