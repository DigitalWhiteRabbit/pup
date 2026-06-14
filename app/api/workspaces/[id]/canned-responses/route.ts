import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  listCannedResponses,
  createCannedResponse,
} from "@/lib/services/tickets/canned-response.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

const createSchema = z.object({
  shortCode: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
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

    const list = await listCannedResponses(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ data: list });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /canned-responses]", err);
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

    const cr = await createCannedResponse(
      workspaceId,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(cr, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[POST /canned-responses]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
