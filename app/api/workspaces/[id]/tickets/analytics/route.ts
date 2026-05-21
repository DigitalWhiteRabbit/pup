import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { getTicketAnalytics } from "@/lib/services/tickets/analytics.service";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
  ServiceRateLimitError,
} from "@/lib/middleware/resolve-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await resolveAuth(request);
    if (!ctx)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    requireScope(ctx, "tickets:analytics");
    requireWorkspace(ctx, workspaceId);

    const analytics = await getTicketAnalytics(
      workspaceId,
      ctx.id,
      ctx.role as "ADMIN" | "USER",
    );

    return NextResponse.json(analytics);
  } catch (err) {
    if (err instanceof ServiceRateLimitError) return err.toResponse();
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /tickets/analytics]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
