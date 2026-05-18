import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    let config = await db.mktConfig.findUnique({ where: { workspaceId } });
    if (!config) {
      config = await db.mktConfig.create({ data: { workspaceId } });
    }

    return NextResponse.json(config);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const body = await req.json();

    // Ensure config exists
    await db.mktConfig.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });

    const config = await db.mktConfig.update({
      where: { workspaceId },
      data: body,
    });

    return NextResponse.json(config);
  });
}
