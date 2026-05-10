import { ApiError } from "@/lib/api-error";
import { parsePdf } from "./pdf.parser";
import { parseDocx } from "./docx.parser";
import { parseXlsx } from "./xlsx.parser";
import { parseText, parseMarkdown } from "./text.parser";

export type ParseResult = {
  title: string;
  content: string;
  metadata: Record<string, unknown>;
};

export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<ParseResult> {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "";

  // Match by mimeType first, fall back to extension
  if (mimeType === "application/pdf" || ext === "pdf") {
    return parsePdf(buffer, originalName);
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return parseDocx(buffer, originalName);
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    return parseXlsx(buffer, originalName);
  }

  if (mimeType === "text/markdown" || ext === "md") {
    return parseMarkdown(buffer, originalName);
  }

  if (
    mimeType.startsWith("text/") ||
    ext === "txt" ||
    ext === "csv" ||
    ext === "json"
  ) {
    return parseText(buffer, originalName);
  }

  throw new ApiError(
    `Неподдерживаемый тип файла: ${mimeType || ext}`,
    "UNSUPPORTED_FILE_TYPE",
    415,
  );
}
