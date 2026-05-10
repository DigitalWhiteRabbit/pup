import type { ParseResult } from "./index";

export function parseText(buffer: Buffer, originalName: string): ParseResult {
  const content = buffer.toString("utf-8");
  const title = originalName.replace(/\.[^.]+$/, "");
  return { title, content, metadata: {} };
}

export function parseMarkdown(
  buffer: Buffer,
  originalName: string,
): ParseResult {
  return parseText(buffer, originalName);
}
