import "server-only";
import { db } from "@/lib/db";
import {
  chunkText,
  embedPassages,
  embeddingToJson,
  EMBEDDING_MODEL,
} from "./embedding.service";

/**
 * KB vector indexing (KB-vector step 2): chunk + embed article/file content into
 * KbChunk. Idempotent (delete-then-insert per source). Reuses the step-1
 * embedding service. NOT wired into search/agent yet (steps 3-4) — this only
 * POPULATES chunks.
 *
 * Embedding is CPU-heavy (seconds). Callers in request handlers MUST use the
 * queue*Index fire-and-forget wrappers (never await) so the request/UI doesn't
 * block. The actual onnx inference runs in onnxruntime-node's native threads,
 * not the JS event loop.
 */

type IndexResult = { chunks: number };

async function indexSource(params: {
  workspaceId: string;
  sourceKind: "article" | "file";
  articleId?: string;
  fileId?: string;
  text: string;
}): Promise<IndexResult> {
  const { workspaceId, sourceKind, articleId, fileId, text } = params;

  // Idempotent: drop this source's existing chunks first.
  if (sourceKind === "article") {
    await db.kbChunk.deleteMany({ where: { articleId } });
  } else {
    await db.kbChunk.deleteMany({ where: { fileId } });
  }

  const chunks = chunkText(text ?? "");
  if (chunks.length === 0) return { chunks: 0 };

  // embedPassages batches internally (8) and applies the e5 "passage: " prefix.
  const embeddings = await embedPassages(chunks);

  await db.kbChunk.createMany({
    data: chunks.map((text_, i) => ({
      workspaceId,
      articleId: articleId ?? null,
      fileId: fileId ?? null,
      sourceKind,
      position: i,
      chunkText: text_,
      embedding: embeddingToJson(embeddings[i]!),
      embeddingModel: EMBEDDING_MODEL,
      tokenCount: text_.split(/\s+/).filter(Boolean).length,
    })),
  });

  return { chunks: chunks.length };
}

/** (Re)index an article's content into KbChunk. Await-able (backfill/tests). */
export function indexArticle(
  workspaceId: string,
  article: { id: string; content: string },
): Promise<IndexResult> {
  return indexSource({
    workspaceId,
    sourceKind: "article",
    articleId: article.id,
    text: article.content,
  });
}

/** (Re)index a file's extracted text into KbChunk. Await-able. */
export function indexFile(
  workspaceId: string,
  file: { id: string; extractedText: string | null },
): Promise<IndexResult> {
  return indexSource({
    workspaceId,
    sourceKind: "file",
    fileId: file.id,
    text: file.extractedText ?? "",
  });
}

export const reindexArticle = indexArticle;
export const reindexFile = indexFile;

// ─── Fire-and-forget wrappers for request handlers (NEVER await) ──────────────

/** Background article (re)index — does NOT block the caller. */
export function queueArticleIndex(
  workspaceId: string,
  article: { id: string; content: string },
): void {
  void indexArticle(workspaceId, article)
    .then((r) => {
      if (r.chunks)
        console.log(`[kb.index] article ${article.id}: ${r.chunks} chunks`);
    })
    .catch((e) =>
      console.error(
        `[kb.index] article ${article.id} failed:`,
        e instanceof Error ? e.message : e,
      ),
    );
}

/** Background file (re)index — does NOT block the caller. */
export function queueFileIndex(
  workspaceId: string,
  file: { id: string; extractedText: string | null },
): void {
  void indexFile(workspaceId, file)
    .then((r) => {
      if (r.chunks)
        console.log(`[kb.index] file ${file.id}: ${r.chunks} chunks`);
    })
    .catch((e) =>
      console.error(
        `[kb.index] file ${file.id} failed:`,
        e instanceof Error ? e.message : e,
      ),
    );
}
