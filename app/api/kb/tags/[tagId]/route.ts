import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { deleteTag } from "@/lib/services/kb/tag.service";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { tagId: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteTag(params.tagId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
