import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { summarizeTicket } from "@/lib/services/agent/agent.service";
import { enforceRateLimit } from "@/lib/services/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // AI call (Anthropic) — cost/DoS limit. Generous: 30/user/hour.
    const limited = enforceRateLimit({
      scope: "ai:summarize",
      userId: session.user.id,
      req: request,
      max: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (limited) return limited;

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
    const summary = await summarizeTicket(
      ticketId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ summary });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[AI summarize]", err);
    return NextResponse.json({ error: "Ошибка AI" }, { status: 500 });
  }
}
