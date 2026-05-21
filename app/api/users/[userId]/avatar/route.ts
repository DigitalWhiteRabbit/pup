import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

type RouteParams = { params: Promise<{ userId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { avatarPath: true },
    });

    if (!user?.avatarPath) return new NextResponse(null, { status: 404 });

    const stream = await storage().download(user.avatarPath);
    const ext = user.avatarPath.split(".").pop() ?? "jpg";
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/jpeg";

    return new NextResponse(stream, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
