import type { ParseResult } from "./index";

export async function parseDocx(
  buffer: Buffer,
  originalName: string,
): Promise<ParseResult> {
  const mammoth = await import("mammoth");
  // mammoth doesn't have convertToMarkdown in the types, use convertToHtml + simple cleanup
  const result = await mammoth.convertToHtml({ buffer });

  // Strip HTML tags to get plain text for content (simple approach)
  const plainText = result.value
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n# $1\n")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<em[^>]*>(.*?)<\/em>/gi, "_$1_")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "\n- $1")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: originalName.replace(/\.docx$/i, ""),
    content: plainText,
    metadata: {
      warnings: result.messages.map((m: { message: string }) => m.message),
    },
  };
}
