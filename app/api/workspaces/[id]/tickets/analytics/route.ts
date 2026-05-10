import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { getTicketAnalytics } from "@/lib/services/tickets/analytics.service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    const analytics = await getTicketAnalytics(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(analytics);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /tickets/analytics]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
