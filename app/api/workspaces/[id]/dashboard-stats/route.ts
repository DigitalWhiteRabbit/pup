import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { ApiError } from "@/lib/api-error";
import { getDashboardStats } from "@/lib/services/dashboard.service";

type Params = { params: Promise<{ id: string }> };

/** GET — lightweight dashboard aggregates (counts + per-column + my-tasks).
 *  Replaces polling the full board every 5s. Membership-gated. */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  try {
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId);
    const stats = await getDashboardStats(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(stats);
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      );
    console.error("[dashboard-stats]", e);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
