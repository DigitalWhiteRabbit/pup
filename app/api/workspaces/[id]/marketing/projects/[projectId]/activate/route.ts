import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { activateProject } from "@/lib/services/marketing/mkt-project.service";

type Params = { params: Promise<{ id: string; projectId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, projectId } = await params;

    const project = await activateProject(workspaceId, projectId);
    return NextResponse.json(project);
  });
}
