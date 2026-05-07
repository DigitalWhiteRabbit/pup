import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  createProjectSchema,
  paginationSchema,
} from "@/lib/schemas/project.schema";
import {
  createProject,
  getProjectsForUser,
} from "@/lib/services/project.service";
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

    const result = await getProjectsForUser(
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
    const input = createProjectSchema.parse(body);

    const project = await createProject({
      name: input.name,
      description: input.description,
      ownerId: session.user.id,
    });

    return NextResponse.json(project, { status: 201 });
  });
}
