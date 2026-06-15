import "server-only";
import { db } from "@/lib/db";
import { embedQuery, cosineSim, jsonToEmbedding } from "./embedding.service";

/**
 * KB-vector step 3 — semantic retrieval over KbChunk (ported from yt-parser
 * searchKnowledge). Embeds the query (e5 "query:" prefix), scores every
 * workspace chunk by cosine similarity against a short-lived in-memory cache,
 * and returns the top-K above a relevance threshold.
 *
 * STRICTLY workspace-scoped: the cache is keyed by workspaceId and only ever
 * loads chunks WHERE workspaceId = the caller's — chunks never cross workspaces.
 */

export type KbChunkHit = {
  chunkText: string;
  sourceKind: "article" | "file";
  articleId: string | null;
  fileId: string | null;
  /** Article title or file name (for citation / display). */
  title: string;
  score: number;
};

/** Default number of chunks returned. */
export const KB_VECTOR_TOP_K = parseInt(process.env.KB_VECTOR_TOP_K || "6", 10);
/**
 * Cosine-similarity floor. e5 normalized embeddings put relevant passages well
 * above unrelated ones; 0.75 keeps genuine matches and drops noise. Tunable.
 */
export const KB_VECTOR_THRESHOLD = parseFloat(
  process.env.KB_VECTOR_THRESHOLD || "0.75",
);

const CACHE_TTL_MS = 60 * 1000;

type CachedChunk = {
  chunkText: string;
  sourceKind: "article" | "file";
  articleId: string | null;
  fileId: string | null;
  title: string;
  vec: Float32Array;
};
type CacheEntry = { at: number; items: CachedChunk[] };

// workspaceId → cached, pre-parsed chunk vectors. Per-workspace so chunks of one
// workspace can never leak into another's search.
const _cache = new Map<string, CacheEntry>();

/** Drop the cache for one workspace (or all). Call on (re)index. */
export function invalidateKbChunkCache(workspaceId?: string): void {
  if (workspaceId) _cache.delete(workspaceId);
  else _cache.clear();
}

async function loadWorkspaceChunks(
  workspaceId: string,
): Promise<CachedChunk[]> {
  const hit = _cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;

  // workspace-scoped query — never reads another workspace's chunks.
  const rows = await db.kbChunk.findMany({
    where: { workspaceId, embedding: { not: null } },
    select: {
      chunkText: true,
      sourceKind: true,
      articleId: true,
      fileId: true,
      embedding: true,
      article: { select: { title: true } },
      file: { select: { originalName: true } },
    },
  });

  // Parse each embedding JSON exactly once per cache window.
  const items: CachedChunk[] = rows.map((r) => ({
    chunkText: r.chunkText,
    sourceKind: r.sourceKind === "file" ? "file" : "article",
    articleId: r.articleId,
    fileId: r.fileId,
    title: r.article?.title ?? r.file?.originalName ?? "",
    vec: jsonToEmbedding(r.embedding!),
  }));

  _cache.set(workspaceId, { at: Date.now(), items });
  return items;
}

/**
 * Semantic search over a workspace's KB chunks. Returns the top-K hits whose
 * cosine similarity is >= threshold, highest first. Empty array when the
 * workspace has no chunks yet or nothing clears the threshold (callers then
 * fall back to keyword search).
 */
export async function searchKbChunks(
  workspaceId: string,
  queryText: string,
  opts: { topK?: number; threshold?: number } = {},
): Promise<KbChunkHit[]> {
  if (!workspaceId) return [];
  if (!queryText || !queryText.trim()) return [];

  const topK = opts.topK ?? KB_VECTOR_TOP_K;
  const threshold = opts.threshold ?? KB_VECTOR_THRESHOLD;

  const items = await loadWorkspaceChunks(workspaceId);
  if (items.length === 0) return [];

  const qvec = await embedQuery(queryText.slice(0, 2000));

  const scored: KbChunkHit[] = items.map((it) => ({
    chunkText: it.chunkText,
    sourceKind: it.sourceKind,
    articleId: it.articleId,
    fileId: it.fileId,
    title: it.title,
    score: cosineSim(qvec, it.vec),
  }));

  return scored
    .filter((h) => h.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
