import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "video/mp4",
  "application/zip",
];

type RouteParams = { params: Promise<{ messageId: string }> };

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { messageId } = await params;
    const msg = await db.globalChatMsg.findUnique({
      where: { id: messageId },
      select: { authorId: true },
    });
    if (!msg || msg.authorId !== session.user.id)
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json({ error: "Файл не указан" }, { status: 400 });
    if (file.size > MAX_FILE_SIZE)
      return NextResponse.json({ error: "Макс 20 МБ" }, { status: 400 });
    const baseMime = file.type.split(";")[0]!.trim();
    if (!ALLOWED_TYPES.includes(baseMime))
      return NextResponse.json(
        { error: `Неподдерживаемый тип: ${baseMime}` },
        { status: 400 },
      );

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await storage().upload({
      scope: "chat",
      workspaceId: "global",
      channelId: "global",
      originalName: file.name,
      buffer,
      mimeType: baseMime,
    });

    const att = await db.globalChatAttachment.create({
      data: {
        messageId,
        originalName: file.name,
        size: result.size,
        mimeType: result.mimeType,
        storagePath: result.storagePath,
      },
    });

    return NextResponse.json(
      {
        id: att.id,
        originalName: att.originalName,
        size: att.size,
        mimeType: att.mimeType,
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
