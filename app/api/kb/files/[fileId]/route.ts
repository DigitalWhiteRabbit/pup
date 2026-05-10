import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { deleteKbFile } from "@/lib/services/kb/file.service";

type Params = { params: { fileId: string } };

export async function DELETE(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteKbFile(params.fileId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
