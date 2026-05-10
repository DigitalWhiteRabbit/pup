import type { ParseResult } from "./index";

export async function parsePdf(
  buffer: Buffer,
  originalName: string,
): Promise<ParseResult> {
  // pdf-parse is a CommonJS module — import as namespace
  const pdfParseModule = await import("pdf-parse");
  const pdfParse =
    typeof pdfParseModule === "function"
      ? pdfParseModule
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((pdfParseModule as any).default ?? pdfParseModule);

  const data = await pdfParse(buffer);
  const info = data.info as Record<string, string> | null;

  return {
    title: info?.Title || originalName.replace(/\.pdf$/i, ""),
    content: data.text as string,
    metadata: {
      pages: data.numpages as number,
      author: info?.Author,
      subject: info?.Subject,
    },
  };
}
