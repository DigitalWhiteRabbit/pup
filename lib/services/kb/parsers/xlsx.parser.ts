import type { ParseResult } from "./index";

export async function parseXlsx(
  buffer: Buffer,
  originalName: string,
): Promise<ParseResult> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const sections: string[] = [];
  const sheetNames = workbook.SheetNames;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    sections.push(`## ${sheetName}\n`);

    const csvData = XLSX.utils.sheet_to_csv(sheet, { FS: "|" });
    const rows = csvData.trim().split("\n");

    if (rows.length > 0) {
      sections.push(`| ${rows[0]?.split("|").join(" | ")} |`);
      const cols = rows[0]?.split("|").length ?? 0;
      sections.push(`| ${Array(cols).fill("---").join(" | ")} |`);
      for (let i = 1; i < rows.length; i++) {
        sections.push(`| ${rows[i]?.split("|").join(" | ")} |`);
      }
    }

    sections.push("\n");
  }

  return {
    title: originalName.replace(/\.xlsx?$/i, ""),
    content: sections.join("\n"),
    metadata: { sheets: sheetNames },
  };
}
