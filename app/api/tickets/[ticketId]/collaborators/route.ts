import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { addCollaborator } from "@/lib/services/tickets/ticket.service";

const addSchema = z.object({
  userId: z.string().min(1),
  role: z
    .enum(["collaborator", "reviewer", "observer"])
    .default("collaborator"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId } = await params;
    const ent = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "tickets",
      },
    );
    const body: unknown = await request.json();
    const validated = addSchema.parse(body);
    await addCollaborator(
      ticketId,
      validated.userId,
      validated.role,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[POST /collaborators]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
