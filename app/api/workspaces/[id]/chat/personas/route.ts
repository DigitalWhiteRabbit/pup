import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  createPersona,
  listPersonas,
} from "@/lib/services/chat/chat-config.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

const createSchema = z.object({
  displayName: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().max(500).optional(),
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

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "tickets",
    });

    const personas = await listPersonas(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ data: personas });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /chat/personas]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "tickets",
    });

    const body: unknown = await request.json();
    const validated = createSchema.parse(body);

    const persona = await createPersona(
      workspaceId,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(persona, { status: 201 });
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
    console.error("[POST /chat/personas]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
