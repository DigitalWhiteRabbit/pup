#!/usr/bin/env node
// Run outside Next.js: node scripts/docx-preview.mjs <filePath> <mode>
// mode: html | text
import mammoth from "mammoth";

const [, , filePath, mode] = process.argv;
if (!filePath) {
  process.stderr.write("Usage: docx-preview.mjs <filePath> [html|text]\n");
  process.exit(1);
}

try {
  const result =
    mode === "text"
      ? await mammoth.extractRawText({ path: filePath })
      : await mammoth.convertToHtml({ path: filePath });
  process.stdout.write(result.value);
} catch (e) {
  process.stderr.write(String(e));
  process.exit(2);
}
