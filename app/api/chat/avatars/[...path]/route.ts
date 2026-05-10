import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/services/storage";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path: pathParts } = await params;
    const storagePath = `personas/${pathParts.join("/")}`;

    const exists = await storage().exists(storagePath);
    if (!exists) {
      return new NextResponse(null, { status: 404 });
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

    return new NextResponse(stream, {
      headers: {
        "Content-Type": mimeMap[ext ?? ""] ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
