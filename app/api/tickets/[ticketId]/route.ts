import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  getTicketById,
  updateTicket,
  deleteTicket,
} from "@/lib/services/tickets/ticket.service";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { z } from "zod";

async function requireTicketAccess(
  session: { user: { id: string; role?: string | null } },
  ticketId: string,
): Promise<void> {
  const ent = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { workspaceId: true },
  });
  if (!ent) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
  await requireWorkspaceAccess(accessCtxFromSession(session), ent.workspaceId, {
    module: "tickets",
  });
}

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z
    .enum(["FINANCIAL", "TECHNICAL", "GENERAL", "BUG", "FEATURE_REQUEST"])
    .optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId } = await params;
    await requireTicketAccess(session, ticketId);
    const ticket = await getTicketById(
      ticketId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(ticket);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /tickets/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId } = await params;
    await requireTicketAccess(session, ticketId);
    const body: unknown = await request.json();
    const data = updateSchema.parse(body);
    const ticket = await updateTicket(
      ticketId,
      data,
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
    console.error("[PATCH /tickets/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId } = await params;
    await requireTicketAccess(session, ticketId);
    await deleteTicket(
      ticketId,
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
    console.error("[DELETE /tickets/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
