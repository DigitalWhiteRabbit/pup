import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { updateWorkspaceSchema } from "@/lib/schemas/workspace.schema";
import {
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
} from "@/lib/services/workspace.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const workspace = await getWorkspaceById(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(workspace);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const input = updateWorkspaceSchema.parse(body);

    const workspace = await updateWorkspace(params.id, input, session.user.id);
    return NextResponse.json(workspace);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteWorkspace(params.id, session.user.id);
    return new NextResponse(null, { status: 204 });
  });
}
