import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "video/mp4",
  "audio/mpeg",
  "audio/webm",
  "audio/ogg",
];

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, channelId, messageId } = await params;

    // Verify message exists and belongs to user
    const msg = await db.chatMsg.findUnique({
      where: { id: messageId },
      select: { authorId: true, channelId: true },
    });
    if (!msg || msg.channelId !== channelId)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (msg.authorId !== session.user.id)
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return NextResponse.json({ error: "Файл не указан" }, { status: 400 });

    if (file.size > MAX_FILE_SIZE)
      return NextResponse.json(
        { error: "Файл слишком большой (макс 20 МБ)" },
        { status: 400 },
      );

    if (!ALLOWED_TYPES.includes(file.type))
      return NextResponse.json(
        { error: "Неподдерживаемый тип файла" },
        { status: 400 },
      );

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await storage().upload({
      scope: "chat",
      workspaceId,
      channelId,
      originalName: file.name,
      buffer,
      mimeType: file.type,
    });

    const attachment = await db.chatMsgAttachment.create({
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
        id: attachment.id,
        originalName: attachment.originalName,
        size: attachment.size,
        mimeType: attachment.mimeType,
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Ошибка загрузки" }, { status: 500 });
  }
}
