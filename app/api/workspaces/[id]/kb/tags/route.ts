import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { listTags, createTag } from "@/lib/services/kb/tag.service";
import { createTagSchema, listTagsSchema } from "@/lib/schemas/kb.schema";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "knowledge",
    });

    const { searchParams } = new URL(req.url);
    const { search } = listTagsSchema.parse(Object.fromEntries(searchParams));

    const tags = await listTags(params.id, session.user.id, session.user.role, {
      search,
    });
    return NextResponse.json(tags);
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "knowledge",
    });

    const body: unknown = await req.json();
    const data = createTagSchema.parse(body);

    const tag = await createTag(
      params.id,
      data,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(tag, { status: 201 });
  });
}
