import "server-only";

/**
 * KB vector embeddings — ported from the proven yt-parser implementation
 * (tools/yt-parser/services/knowledge.js). Local, free, multilingual:
 * Xenova/multilingual-e5-small (384-dim, quantized) via @xenova/transformers
 * (native onnxruntime-node backend, same as yt-parser).
 *
 * The model is downloaded on first use (cached under
 * node_modules/@xenova/transformers/.cache) — call warmup() to pre-load + warm
 * the onnx session so the first real request doesn't pay 5–30s init.
 *
 * STEP 1 (foundation): this module is NOT wired into ingest/search/agent yet.
 */

export const EMBEDDING_MODEL =
  process.env.KB_EMBEDDING_MODEL || "Xenova/multilingual-e5-small";
/** multilingual-e5-small output dimensionality. */
export const EMBEDDING_DIM = 384;

const CHUNK_SIZE = parseInt(process.env.KB_CHUNK_SIZE || "800", 10);
const CHUNK_OVERLAP = parseInt(process.env.KB_CHUNK_OVERLAP || "100", 10);
const EMBED_BATCH = 8;

// e5 models require these prefixes for documents vs queries.
const PASSAGE_PREFIX = "passage: ";
const QUERY_PREFIX = "query: ";

// Minimal shape of the @xenova feature-extraction pipeline output (a Tensor).
type EmbedderOutput = { data: Float32Array; dims: number[] };
type Embedder = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<EmbedderOutput>;

// ─── Lazy singleton pipeline ──────────────────────────────────────────────

let _embedderPromise: Promise<Embedder> | null = null;
let _embedderReady = false;

export async function getEmbedder(): Promise<Embedder> {
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    // dynamic import — @xenova/transformers is ESM-only
    const { pipeline, env } = await import("@xenova/transformers");
    // Allow downloading the model (cached in node_modules/@xenova/.../.cache)
    env.allowRemoteModels = true;
    const pipe = (await pipeline("feature-extraction", EMBEDDING_MODEL, {
      quantized: true,
    })) as unknown as Embedder;
    _embedderReady = true;
    return pipe;
  })().catch((e) => {
    _embedderPromise = null;
    throw e;
  });
  return _embedderPromise;
}

export function isEmbedderReady(): boolean {
  return _embedderReady;
}

/** Pre-load the model + run a dummy inference so the first real call is fast. */
export async function warmup(): Promise<void> {
  try {
    const embedder = await getEmbedder();
    await embedder(QUERY_PREFIX + "warmup", {
      pooling: "mean",
      normalize: true,
    });
  } catch (e) {
    console.warn(
      "[kb.embedding.warmup] embedder init failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ─── Chunking ──────────────────────────────────────────────────────────────

/** Word-based sliding window with overlap (env-tunable KB_CHUNK_SIZE/OVERLAP). */
export function chunkText(
  text: string,
  opts: { size?: number; overlap?: number } = {},
): string[] {
  const size = opts.size || CHUNK_SIZE;
  const overlap = opts.overlap || CHUNK_OVERLAP;
  const words = String(text || "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break;
    i += Math.max(1, size - overlap);
  }
  return chunks;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

async function embedBatch(
  texts: string[],
  prefix: string,
): Promise<Float32Array[]> {
  const embedder = await getEmbedder();
  const inputs = texts.map((t) => prefix + String(t));
  const output = await embedder(inputs, { pooling: "mean", normalize: true });
  const D = output.dims[output.dims.length - 1]!;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    const arr = new Float32Array(D);
    arr.set(output.data.slice(i * D, (i + 1) * D));
    result.push(arr);
  }
  return result;
}

async function embed(texts: string[], prefix: string): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH), prefix)));
  }
  return out;
}

/** Embed documents/passages (e5 "passage: " prefix). Batched at 8. */
export function embedPassages(texts: string[]): Promise<Float32Array[]> {
  return embed(texts, PASSAGE_PREFIX);
}

/** Embed a single search query (e5 "query: " prefix). */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vec] = await embed([String(text).slice(0, 2000)], QUERY_PREFIX);
  return vec!;
}

// ─── Math + (de)serialization ───────────────────────────────────────────────

export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Store embedding as a JSON float-array string (Prisma String column). */
export function embeddingToJson(f32: Float32Array): string {
  return JSON.stringify(Array.from(f32));
}

export function jsonToEmbedding(str: string): Float32Array {
  return Float32Array.from(JSON.parse(str) as number[]);
}
