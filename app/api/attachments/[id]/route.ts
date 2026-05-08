import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import {
  downloadAttachment,
  deleteAttachment,
} from "@/lib/services/attachment.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const result = await downloadAttachment(
      params.id,
      session.user.id,
      session.user.role,
    );

    const url = new URL(req.url);
    const forceDownload = url.searchParams.get("download") === "1";
    const disposition = forceDownload ? "attachment" : "inline";

    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.mimeType,
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(result.originalName)}"`,
        "Content-Length": String(result.size),
      },
    });
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteAttachment(params.id, session.user.id, session.user.role);
    return new NextResponse(null, { status: 204 });
  });
}
