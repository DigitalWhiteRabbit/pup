import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "@/lib/services/membership-check";

const schema = z.object({
  ticketIds: z.array(z.string()).min(1).max(100),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;

    // Must be a workspace member (OWNER) or global ADMIN — global ADMIN alone
    // shouldn't be able to mass-delete tickets of a workspace they're not in.
    const membership = await checkMembership(workspaceId, session.user.id);
    if (membership !== "OWNER" && session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Только администратор может удалять тикеты" },
        { status: 403 },
      );
    }
    const body: unknown = await request.json();
    const { ticketIds } = schema.parse(body);

    const result = await db.ticket.deleteMany({
      where: {
        id: { in: ticketIds },
        workspaceId,
      },
    });

    return NextResponse.json({ deleted: result.count });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[POST /tickets/bulk-delete]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
