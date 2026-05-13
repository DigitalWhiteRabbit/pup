import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
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
