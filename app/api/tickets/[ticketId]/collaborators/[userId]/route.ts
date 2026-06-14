import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { removeCollaborator } from "@/lib/services/tickets/ticket.service";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ ticketId: string; userId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId, userId } = await params;
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
    await removeCollaborator(
      ticketId,
      userId,
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
    console.error("[DELETE /collaborators]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
