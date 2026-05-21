import type { ParseResult } from "./index";

export async function parseXlsx(
  buffer: Buffer,
  originalName: string,
): Promise<ParseResult> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  );

  const sections: string[] = [];
  const sheetNames: string[] = [];

  workbook.eachSheet((sheet) => {
    sheetNames.push(sheet.name);
    sections.push(`## ${sheet.name}\n`);

    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(String(cell.value ?? ""));
      });
      rows.push(cells);
    });

    if (rows.length > 0) {
      const colCount = Math.max(...rows.map((r) => r.length));

      // Header row
      const header = rows[0] ?? [];
      sections.push(
        `| ${Array.from({ length: colCount }, (_, i) => header[i] ?? "").join(" | ")} |`,
      );
      sections.push(`| ${Array(colCount).fill("---").join(" | ")} |`);

      // Data rows
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] ?? [];
        sections.push(
          `| ${Array.from({ length: colCount }, (_, j) => row[j] ?? "").join(" | ")} |`,
        );
      }
    }

    sections.push("\n");
  });

  return {
    title: originalName.replace(/\.xlsx?$/i, ""),
    content: sections.join("\n"),
    metadata: { sheets: sheetNames },
  };
}
