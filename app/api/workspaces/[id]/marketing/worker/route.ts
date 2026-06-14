import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { getStatus, stop } from "@/lib/services/marketing/mkt-worker.service";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    const status = await getStatus(workspaceId);
    return NextResponse.json(status);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    const { action } = await req.json();
    if (action === "start") {
      // FROZEN 2026-06-13: движок PUP выведен из эксплуатации после унификации БД.
      // Единый источник outreach — yt-parser против общего Postgres. Запуск здесь
      // создал бы второго писателя в ту же БД. start() намеренно заблокирован.
      throw new ApiError(
        "PUP marketing engine frozen — outreach runs in yt-parser (unified DB)",
        "MKT_ENGINE_FROZEN",
        410,
      );
    } else if (action === "stop") {
      await stop();
    } else {
      throw new ApiError("Неверное действие", "BAD_REQUEST", 400);
    }

    const status = await getStatus(workspaceId);
    return NextResponse.json(status);
  });
}
