import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { assignTicket } from "@/lib/services/tickets/ticket.service";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { z } from "zod";

const schema = z.object({
  assigneeId: z.string().nullable(),
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
    const { assigneeId } = schema.parse(body);
    const ticket = await assignTicket(
      ticketId,
      assigneeId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(ticket);
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
    console.error("[POST /tickets/:id/assign]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
