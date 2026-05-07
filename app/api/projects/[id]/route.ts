import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { updateProjectSchema } from "@/lib/schemas/project.schema";
import {
  getProjectById,
  updateProject,
  deleteProject,
} from "@/lib/services/project.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const project = await getProjectById(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(project);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const input = updateProjectSchema.parse(body);

    const project = await updateProject(params.id, input, session.user.id);
    return NextResponse.json(project);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteProject(params.id, session.user.id);
    return new NextResponse(null, { status: 204 });
  });
}
