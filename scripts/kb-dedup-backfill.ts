/**
 * Backfill normalizedUrl + contentHash for existing KbArticle (and contentHash
 * for KbFile.extractedText) so dedup detection/audit can work on legacy rows.
 * Idempotent, additive (only fills/refreshes the two fields, never deletes).
 *
 *   pnpm exec tsx --conditions=react-server scripts/kb-dedup-backfill.ts [--apply]
 *
 * DRY-RUN by default (counts what would change). --apply writes.
 */
import { db } from "../lib/db";
import {
  normalizeUrl,
  computeContentHash,
} from "../lib/services/kb/dedup.service";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(`=== kb-dedup-backfill — ${APPLY ? "APPLY" : "DRY-RUN"} ===\n`);

  const articles = await db.kbArticle.findMany({
    select: {
      id: true,
      sourceUrl: true,
      content: true,
      normalizedUrl: true,
      contentHash: true,
    },
  });
  let artChanged = 0;
  for (const a of articles) {
    const nu = normalizeUrl(a.sourceUrl);
    const ch = computeContentHash(a.content);
    if (a.normalizedUrl !== nu || a.contentHash !== ch) {
      artChanged++;
      if (APPLY) {
        await db.kbArticle.update({
          where: { id: a.id },
          data: { normalizedUrl: nu, contentHash: ch },
        });
      }
    }
  }

  const files = await db.kbFile.findMany({
    where: { extractedText: { not: null } },
    select: { id: true, extractedText: true, contentHash: true },
  });
  let fileChanged = 0;
  for (const f of files) {
    const ch = computeContentHash(f.extractedText);
    if (f.contentHash !== ch) {
      fileChanged++;
      if (APPLY) {
        await db.kbFile.update({
          where: { id: f.id },
          data: { contentHash: ch },
        });
      }
    }
  }

  console.log(`articles: ${articles.length}, would update: ${artChanged}`);
  console.log(
    `files (with extractedText): ${files.length}, would update: ${fileChanged}`,
  );
  console.log(
    APPLY ? "\nApplied." : "\n(dry-run — re-run with --apply to write)",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
