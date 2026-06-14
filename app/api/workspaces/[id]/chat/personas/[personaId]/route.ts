import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  updatePersona,
  deletePersona,
} from "@/lib/services/chat/chat-config.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

const updateSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  scheduleDays: z.string().max(100).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; personaId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, personaId } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "tickets",
    });

    const body: unknown = await request.json();
    const validated = updateSchema.parse(body);

    const persona = await updatePersona(
      personaId,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(persona);
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
    console.error("[PATCH /chat/personas/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; personaId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, personaId } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "tickets",
    });

    await deletePersona(
      personaId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[DELETE /chat/personas/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
