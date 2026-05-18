import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/lib/services/marketing/mkt-project.service";

type Params = { params: Promise<{ id: string; projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, projectId } = await params;

    const project = await getProject(workspaceId, projectId);
    return NextResponse.json(project);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, projectId } = await params;

    const body = await req.json();
    const project = await updateProject(workspaceId, projectId, body);
    return NextResponse.json(project);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, projectId } = await params;

    await deleteProject(workspaceId, projectId);
    return NextResponse.json({ ok: true });
  });
}
