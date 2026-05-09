import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  createWorkspaceSchema,
  paginationSchema,
} from "@/lib/schemas/workspace.schema";
import {
  createWorkspace,
  getWorkspacesForUser,
} from "@/lib/services/workspace.service";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const { searchParams } = new URL(request.url);
    const { page, limit } = paginationSchema.parse({
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("pageSize") ?? undefined,
    });

    const result = await getWorkspacesForUser(
      session.user.id,
      session.user.role,
      page,
      limit,
    );

    return NextResponse.json(result);
  });
}

export async function POST(request: Request) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const input = createWorkspaceSchema.parse(body);

    const workspace = await createWorkspace({
      name: input.name,
      description: input.description,
      ownerId: session.user.id,
    });

    return NextResponse.json(workspace, { status: 201 });
  });
}
