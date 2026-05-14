import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json({ error: "Файл не указан" }, { status: 400 });
    if (file.size > MAX_SIZE)
      return NextResponse.json({ error: "Макс 5 МБ" }, { status: 400 });
    const baseMime = file.type.split(";")[0]!.trim();
    if (!ALLOWED.includes(baseMime))
      return NextResponse.json(
        { error: "Только изображения" },
        { status: 400 },
      );

    // Delete old avatar
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { avatarPath: true },
    });
    if (user?.avatarPath) {
      try {
        await storage().delete(user.avatarPath);
      } catch {
        /* ok */
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await storage().upload({
      scope: "persona",
      workspaceId: "avatars",
      originalName: file.name,
      buffer,
      mimeType: baseMime,
    });

    await db.user.update({
      where: { id: session.user.id },
      data: { avatarPath: result.storagePath },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { avatarPath: true },
    });
    if (user?.avatarPath) {
      try {
        await storage().delete(user.avatarPath);
      } catch {
        /* ok */
      }
    }

    await db.user.update({
      where: { id: session.user.id },
      data: { avatarPath: null },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
