import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { removeMember } from "@/lib/services/workspace.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string; userId: string } };

export async function DELETE(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await removeMember(params.id, params.userId, session.user.id);
    return new NextResponse(null, { status: 204 });
  });
}
