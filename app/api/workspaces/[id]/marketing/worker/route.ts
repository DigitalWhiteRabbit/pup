import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getStatus,
  start,
  stop,
} from "@/lib/services/marketing/mkt-worker.service";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

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

    const { action } = await req.json();
    if (action === "start") {
      start(workspaceId);
    } else if (action === "stop") {
      stop();
    } else {
      throw new ApiError("Неверное действие", "BAD_REQUEST", 400);
    }

    const status = await getStatus(workspaceId);
    return NextResponse.json(status);
  });
}
