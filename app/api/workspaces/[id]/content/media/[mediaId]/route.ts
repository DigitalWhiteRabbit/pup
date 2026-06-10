import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getMediaForDownload } from "@/lib/services/content.service";
import { storage } from "@/lib/services/storage";

type Params = { params: { id: string; mediaId: string } };

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** GET — отдать файл фото медиа (только участникам с доступом к модулю) */
export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session?.user?.id) return new NextResponse(null, { status: 401 });

    const { storagePath, name } = await getMediaForDownload(
      params.id,
      params.mediaId,
      session.user.id,
      session.user.role,
    );

    const stream = await storage().download(storagePath);
    const ext = (name ?? storagePath).split(".").pop()?.toLowerCase() ?? "jpg";
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

    return new NextResponse(stream, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
