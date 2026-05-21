import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getStatus,
  start,
  stop,
} from "@/lib/services/marketing/mkt-worker.service";
import { checkMembership } from "@/lib/services/workspace.service";

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

    const { action } = await req.json();
    if (action === "start") {
      await start(workspaceId);
    } else if (action === "stop") {
      await stop();
    } else {
      throw new ApiError("Неверное действие", "BAD_REQUEST", 400);
    }

    const status = await getStatus(workspaceId);
    return NextResponse.json(status);
  });
}
