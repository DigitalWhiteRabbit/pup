import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/services/storage";
import { withCors, corsResponse } from "@/lib/services/chat/cors";

// Public persona avatars. Loaded as <img> (which doesn't need CORS), but we add
// CORS headers anyway so this stays safe after the edge-middleware CORS block is
// removed and in case it's ever fetched (not <img>'d) from an embedded widget.
// No slug here → no per-workspace allowlist; default ACAO "*" (public images,
// never credentialed).

export async function OPTIONS(req: NextRequest) {
  return corsResponse(req.headers.get("origin"));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const origin = req.headers.get("origin");
  try {
    const { path: pathParts } = await params;
    const storagePath = `personas/${pathParts.join("/")}`;

    const exists = await storage().exists(storagePath);
    if (!exists) {
      return withCors(new NextResponse(null, { status: 404 }), origin);
    }

    const stream = await storage().download(storagePath);

    // Определяем MIME по расширению
    const ext = storagePath.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };

    return withCors(
      new NextResponse(stream, {
        headers: {
          "Content-Type": mimeMap[ext ?? ""] ?? "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        },
      }),
      origin,
    );
  } catch {
    return withCors(new NextResponse(null, { status: 404 }), origin);
  }
}
