import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-error", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

// ─── parseText / parseMarkdown ────────────────────────────────────────────────

describe("parseText", () => {
  it("returns content unchanged", async () => {
    const { parseText } = await import("@/lib/services/kb/parsers/text.parser");
    const buf = Buffer.from("Hello World");
    const result = parseText(buf, "test.txt");
    expect(result.content).toBe("Hello World");
  });

  it("strips extension from title", async () => {
    const { parseText } = await import("@/lib/services/kb/parsers/text.parser");
    const result = parseText(Buffer.from("content"), "my-doc.txt");
    expect(result.title).toBe("my-doc");
    expect(result.metadata).toEqual({});
  });
});

describe("parseMarkdown", () => {
  it("returns same content as parseText", async () => {
    const { parseMarkdown } =
      await import("@/lib/services/kb/parsers/text.parser");
    const content = "# Header\n\nParagraph";
    const result = parseMarkdown(Buffer.from(content), "readme.md");
    expect(result.content).toBe(content);
    expect(result.title).toBe("readme");
  });
});

// ─── parseXlsx ────────────────────────────────────────────────────────────────

describe("parseXlsx", () => {
  it("creates Markdown table from single sheet", async () => {
    const XLSX = await import("xlsx");
    const { parseXlsx } = await import("@/lib/services/kb/parsers/xlsx.parser");

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "Age"],
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = Buffer.from(
      XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
    );

    const result = await parseXlsx(buf, "data.xlsx");
    expect(result.title).toBe("data");
    expect(result.content).toContain("Sheet1");
    expect(result.content).toContain("Name");
    expect(result.content).toContain("Alice");
    expect(result.metadata.sheets).toEqual(["Sheet1"]);
  });

  it("handles multiple sheets", async () => {
    const XLSX = await import("xlsx");
    const { parseXlsx } = await import("@/lib/services/kb/parsers/xlsx.parser");

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A"]]), "Alpha");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["B"]]), "Beta");
    const buf = Buffer.from(
      XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
    );

    const result = await parseXlsx(buf, "multi.xlsx");
    expect(result.content).toContain("Alpha");
    expect(result.content).toContain("Beta");
    expect((result.metadata.sheets as string[]).length).toBe(2);
  });
});

// ─── parseDocument dispatcher ─────────────────────────────────────────────────

describe("parseDocument", () => {
  it("routes txt by mimeType", async () => {
    const { parseDocument } = await import("@/lib/services/kb/parsers/index");
    const result = await parseDocument(
      Buffer.from("plain text"),
      "text/plain",
      "file.txt",
    );
    expect(result.content).toBe("plain text");
  });

  it("routes markdown by extension", async () => {
    const { parseDocument } = await import("@/lib/services/kb/parsers/index");
    const result = await parseDocument(
      Buffer.from("# Hello"),
      "application/octet-stream",
      "doc.md",
    );
    expect(result.content).toBe("# Hello");
  });

  it("throws on unsupported type", async () => {
    const { parseDocument } = await import("@/lib/services/kb/parsers/index");
    const { ApiError } = await import("@/lib/api-error");
    await expect(
      parseDocument(Buffer.from("data"), "application/zip", "file.zip"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
