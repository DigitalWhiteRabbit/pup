import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const att = await db.globalChatAttachment.findUnique({ where: { id } });
    if (!att)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });

    const stream = await storage().download(att.storagePath);
    const url = new URL(req.url);
    const forceDownload = url.searchParams.get("download") === "1";
    const safeInline =
      /^(image|audio|video)\//.test(att.mimeType) ||
      att.mimeType === "application/pdf";
    const disposition = !forceDownload && safeInline ? "inline" : "attachment";

    return new NextResponse(stream, {
      headers: {
        "Content-Type": att.mimeType,
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(att.originalName)}"`,
        "Content-Length": String(att.size),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
