/**
 * KB-vector backfill — chunk + embed ALL existing KB content into KbChunk.
 *
 * Idempotent (indexArticle/indexFile do delete-then-insert per source), so a
 * second run produces the same chunks with no duplicates. Indexes every
 * article (all workspaces) and every file that already has extractedText.
 *
 * embedding.service / index.service are "server-only" → run with the
 * react-server condition so the server-only shim resolves to a no-op:
 *
 *   pnpm exec tsx --conditions=react-server scripts/kb-backfill-embeddings.ts --dry-run   # counts, no writes
 *   pnpm exec tsx --conditions=react-server scripts/kb-backfill-embeddings.ts --apply     # writes KbChunk
 *
 * --dry-run is the default (never writes). It uses chunkText only (cheap, no
 * model). --apply downloads the model on first use (cached under
 * node_modules/@xenova/.../.cache) and embeds — this is CPU-heavy and may take
 * a while on a large KB. Run it MANUALLY on prod after deploy.
 */
import { db } from "../lib/db";
import { chunkText } from "../lib/services/kb/embedding.service";
import { indexArticle, indexFile } from "../lib/services/kb/index.service";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(
    `=== KB-vector backfill — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"} ===\n`,
  );

  const articles = await db.kbArticle.findMany({
    select: { id: true, workspaceId: true, content: true },
  });
  const files = await db.kbFile.findMany({
    where: { extractedText: { not: null } },
    select: { id: true, workspaceId: true, extractedText: true },
  });

  let articleChunks = 0;
  let fileChunks = 0;
  let articlesDone = 0;
  let filesDone = 0;

  for (const a of articles) {
    articleChunks += chunkText(a.content ?? "").length;
    if (APPLY) {
      const r = await indexArticle(a.workspaceId, {
        id: a.id,
        content: a.content,
      });
      articlesDone++;
      if (articlesDone % 10 === 0 || articlesDone === articles.length) {
        console.log(
          `  articles ${articlesDone}/${articles.length} (+${r.chunks} chunks)`,
        );
      }
    }
  }

  for (const f of files) {
    fileChunks += chunkText(f.extractedText ?? "").length;
    if (APPLY) {
      const r = await indexFile(f.workspaceId, {
        id: f.id,
        extractedText: f.extractedText,
      });
      filesDone++;
      if (filesDone % 10 === 0 || filesDone === files.length) {
        console.log(
          `  files ${filesDone}/${files.length} (+${r.chunks} chunks)`,
        );
      }
    }
  }

  console.log(
    `\narticles: ${articles.length} (~${articleChunks} chunks)\n` +
      `files (with extractedText): ${files.length} (~${fileChunks} chunks)\n` +
      `total expected chunks: ~${articleChunks + fileChunks}`,
  );

  if (APPLY) {
    const total = await db.kbChunk.count();
    console.log(
      `\nindexed ${articlesDone} articles + ${filesDone} files. KbChunk total now = ${total}`,
    );
  } else {
    console.log("\n(dry-run — nothing written; re-run with --apply to index)");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
