import * as fs from "node:fs/promises";
import * as path from "node:path";
import mammoth from "mammoth";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: { fileId: string } };

function getUploadDir(): string {
  return path.resolve(process.env["UPLOAD_DIR"] ?? "./uploads");
}

function resolveStoragePath(storagePath: string): string {
  const uploadDir = getUploadDir();
  const resolved = path.resolve(path.join(uploadDir, storagePath));
  // Guard path traversal
  if (!resolved.startsWith(uploadDir + path.sep) && resolved !== uploadDir) {
    throw new ApiError("Недопустимый путь", "INVALID_PATH", 400);
  }
  return resolved;
}

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const kbFile = await db.kbFile.findUnique({ where: { id: params.fileId } });
    if (!kbFile) throw new ApiError("Файл не найден", "NOT_FOUND", 404);

    const membership = await checkMembership(kbFile.workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const mime = kbFile.mimeType;
    const name = kbFile.originalName.toLowerCase();
    const filePath = resolveStoragePath(kbFile.storagePath);

    // Plain text
    if (
      mime.startsWith("text/") ||
      name.endsWith(".txt") ||
      name.endsWith(".md") ||
      name.endsWith(".csv") ||
      name.endsWith(".json")
    ) {
      const content = await fs.readFile(filePath, "utf-8");
      return NextResponse.json({ type: "text", content });
    }

    // Images
    if (mime.startsWith("image/")) {
      const buf = await fs.readFile(filePath);
      return NextResponse.json({
        type: "image",
        content: `data:${mime};base64,${buf.toString("base64")}`,
      });
    }

    // DOCX / DOC
    if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/msword" ||
      name.endsWith(".docx") ||
      name.endsWith(".doc")
    ) {
      const buf = await fs.readFile(filePath);
      const isDocx =
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        name.endsWith(".docx");
      const result = isDocx
        ? await mammoth.convertToHtml({ buffer: buf })
        : await mammoth.extractRawText({ buffer: buf });
      const type = isDocx ? "html" : "text";
      return NextResponse.json({ type, content: result.value });
    }

    // PDF
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      type PdfFn = (buf: Buffer) => Promise<{ text: string }>;
      const pdfModule = (await import("pdf-parse")) as unknown as { default?: PdfFn } & PdfFn;
      const pdfParse: PdfFn =
        typeof pdfModule.default === "function" ? pdfModule.default : pdfModule;
      const buf = await fs.readFile(filePath);
      const data = await pdfParse(buf);
      return NextResponse.json({ type: "text", content: data.text });
    }

    return NextResponse.json({ type: "unsupported", content: "" });
  });
}
