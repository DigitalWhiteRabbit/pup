import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: { fileId: string } };

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const kbFile = await db.kbFile.findUnique({ where: { id: params.fileId } });
    if (!kbFile) throw new ApiError("Файл не найден", "NOT_FOUND", 404);

    const membership = await checkMembership(
      kbFile.workspaceId,
      session.user.id,
    );
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const mime = kbFile.mimeType;
    const name = kbFile.originalName.toLowerCase();

    // Plain text
    if (
      mime.startsWith("text/") ||
      name.endsWith(".txt") ||
      name.endsWith(".md") ||
      name.endsWith(".csv") ||
      name.endsWith(".json")
    ) {
      const stream = await storage().download(kbFile.storagePath);
      const buf = await streamToBuffer(stream);
      return NextResponse.json({
        type: "text",
        content: buf.toString("utf-8"),
      });
    }

    // Images
    if (mime.startsWith("image/")) {
      const stream = await storage().download(kbFile.storagePath);
      const buf = await streamToBuffer(stream);
      const b64 = buf.toString("base64");
      return NextResponse.json({
        type: "image",
        content: `data:${mime};base64,${b64}`,
      });
    }

    // DOCX
    if (
      mime ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const stream = await storage().download(kbFile.storagePath);
      const buf = await streamToBuffer(stream);
      const result = await mammoth.convertToHtml({ buffer: buf });
      return NextResponse.json({ type: "html", content: result.value });
    }

    // DOC (старый формат) — только текст
    if (mime === "application/msword" || name.endsWith(".doc")) {
      const mammoth = await import("mammoth");
      const stream = await storage().download(kbFile.storagePath);
      const buf = await streamToBuffer(stream);
      const result = await mammoth.extractRawText({ buffer: buf });
      return NextResponse.json({ type: "text", content: result.value });
    }

    // PDF
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const pdfModule = await import("pdf-parse");
      const pdfParse =
        "default" in pdfModule
          ? (
              pdfModule as {
                default: (buf: Buffer) => Promise<{ text: string }>;
              }
            ).default
          : (pdfModule as unknown as (
              buf: Buffer,
            ) => Promise<{ text: string }>);
      const stream = await storage().download(kbFile.storagePath);
      const buf = await streamToBuffer(stream);
      const data = await pdfParse(buf);
      return NextResponse.json({ type: "text", content: data.text });
    }

    // Unsupported
    return NextResponse.json({ type: "unsupported", content: "" });
  });
}
