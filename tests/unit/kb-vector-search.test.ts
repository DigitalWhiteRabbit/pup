import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// KB-vector step 3 — semantic retrieval tests. Mock the DB with an in-memory,
// workspace-filtered KbChunk store; use the REAL embedder so cosine scores are
// genuine. Model downloads on first run (cached) → long timeouts.

vi.mock("server-only", () => ({}));

type Row = {
  workspaceId: string;
  chunkText: string;
  sourceKind: string;
  articleId: string | null;
  fileId: string | null;
  embedding: string | null;
  article: { title: string } | null;
  file: { originalName: string } | null;
};

const store = vi.hoisted(() => {
  const rows: Row[] = [];
  return {
    rows,
    reset() {
      rows.length = 0;
    },
    // Mimics db.kbChunk.findMany({ where: { workspaceId, embedding: { not: null } } })
    findMany({ where }: { where: { workspaceId: string } }) {
      return Promise.resolve(
        rows.filter(
          (r) => r.workspaceId === where.workspaceId && r.embedding !== null,
        ),
      );
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: { kbChunk: { findMany: store.findMany } },
}));

import {
  searchKbChunks,
  invalidateKbChunkCache,
} from "@/lib/services/kb/vector-search.service";
import {
  embedPassages,
  embeddingToJson,
  warmup,
} from "@/lib/services/kb/embedding.service";

async function makeRow(
  workspaceId: string,
  text: string,
  opts: { title?: string; sourceKind?: string } = {},
): Promise<Row> {
  const [vec] = await embedPassages([text]);
  return {
    workspaceId,
    chunkText: text,
    sourceKind: opts.sourceKind ?? "article",
    articleId: opts.sourceKind === "file" ? null : "art-" + text.slice(0, 4),
    fileId: opts.sourceKind === "file" ? "file-" + text.slice(0, 4) : null,
    embedding: embeddingToJson(vec!),
    article:
      opts.sourceKind === "file" ? null : { title: opts.title ?? "Статья" },
    file:
      opts.sourceKind === "file" ? { originalName: opts.title ?? "doc" } : null,
  };
}

const PAYMENT =
  "Оплатить рекламу можно банковской картой или банковским переводом";
const WEATHER = "Сегодня в Москве солнечная погода и лёгкий северный ветер";

describe("kb vector-search (model-backed)", () => {
  beforeAll(async () => {
    await warmup();
  }, 300_000);

  beforeEach(() => {
    store.reset();
    invalidateKbChunkCache();
  });

  it("semantic: paraphrase finds the relevant chunk; threshold cuts the irrelevant one", async () => {
    store.rows.push(
      await makeRow("ws-1", PAYMENT, { title: "Оплата рекламы" }),
      await makeRow("ws-1", WEATHER, { title: "Погода" }),
    );

    // paraphrase of the payment chunk (different words, same meaning)
    const hits = await searchKbChunks("ws-1", "как мне заплатить за рекламу", {
      threshold: 0.8,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    // top hit is the payment chunk, not the weather one
    expect(hits[0]!.chunkText).toBe(PAYMENT);
    expect(hits[0]!.title).toBe("Оплата рекламы");
    expect(hits[0]!.sourceKind).toBe("article");
    // irrelevant weather chunk is below threshold → excluded
    expect(hits.some((h) => h.chunkText === WEATHER)).toBe(false);
  }, 120_000);

  it("threshold: a totally unrelated query returns nothing", async () => {
    store.rows.push(await makeRow("ws-1", PAYMENT, { title: "Оплата" }));
    const hits = await searchKbChunks(
      "ws-1",
      "рецепт борща с говядиной и свёклой",
      { threshold: 0.85 },
    );
    expect(hits).toHaveLength(0);
  }, 120_000);

  it("workspace-scoped: another workspace's chunks are never returned", async () => {
    store.rows.push(
      await makeRow("ws-1", PAYMENT, { title: "WS1 оплата" }),
      await makeRow("ws-2", PAYMENT, { title: "WS2 оплата" }),
    );
    const hits = await searchKbChunks("ws-1", "оплата рекламы картой", {
      threshold: 0.7,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.title === "WS1 оплата")).toBe(true);
  }, 120_000);

  it("cache: a reindexed (new) chunk is found only after invalidation", async () => {
    store.rows.push(await makeRow("ws-1", WEATHER, { title: "Погода" }));
    // warm the cache (no payment chunk yet)
    const before = await searchKbChunks("ws-1", "оплата рекламы картой", {
      threshold: 0.8,
    });
    expect(before).toHaveLength(0);

    // simulate (re)index adding a payment chunk
    store.rows.push(await makeRow("ws-1", PAYMENT, { title: "Оплата" }));

    // without invalidation → stale cache, still not found
    const stale = await searchKbChunks("ws-1", "оплата рекламы картой", {
      threshold: 0.8,
    });
    expect(stale).toHaveLength(0);

    // after invalidation (index.service calls this on every (re)index)
    invalidateKbChunkCache("ws-1");
    const fresh = await searchKbChunks("ws-1", "оплата рекламы картой", {
      threshold: 0.8,
    });
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh[0]!.chunkText).toBe(PAYMENT);
  }, 180_000);
});
