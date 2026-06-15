import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// KB-vector step 2 — indexing tests. Mock the DB with an in-memory KbChunk
// store (no Postgres needed) but use the REAL embedder, so we assert genuine
// 384-dim vectors. The model downloads on first run (cached) → long timeouts.

vi.mock("server-only", () => ({}));

// In-memory KbChunk store driving the mocked Prisma client.
const store = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  return {
    rows,
    reset() {
      rows.length = 0;
    },
    deleteMany({ where }: { where: { articleId?: string; fileId?: string } }) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (
          (where.articleId !== undefined &&
            r["articleId"] === where.articleId) ||
          (where.fileId !== undefined && r["fileId"] === where.fileId)
        ) {
          rows.splice(i, 1);
        }
      }
      return Promise.resolve({ count: before - rows.length });
    },
    createMany({ data }: { data: Row[] }) {
      rows.push(...data);
      return Promise.resolve({ count: data.length });
    },
    count() {
      return Promise.resolve(rows.length);
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    kbChunk: {
      deleteMany: store.deleteMany,
      createMany: store.createMany,
      count: store.count,
    },
  },
}));

import { indexArticle, indexFile } from "@/lib/services/kb/index.service";
import {
  warmup,
  jsonToEmbedding,
  EMBEDDING_DIM,
} from "@/lib/services/kb/embedding.service";

// ~1000 words → 2 chunks (size 800 / overlap 100: starts 0, 700; break at 700).
const longText = (n: number) =>
  Array.from({ length: n }, (_, i) => `слово${i}`).join(" ");

describe("kb index.service (model-backed)", () => {
  beforeAll(async () => {
    await warmup();
  }, 300_000);

  beforeEach(() => store.reset());

  it("indexArticle → KbChunks with 384-dim embeddings + correct fields/positions", async () => {
    const res = await indexArticle("ws-1", {
      id: "art-1",
      content: longText(1000),
    });
    expect(res.chunks).toBe(2);
    expect(store.rows).toHaveLength(2);

    store.rows.forEach((r, i) => {
      expect(r["workspaceId"]).toBe("ws-1");
      expect(r["articleId"]).toBe("art-1");
      expect(r["fileId"]).toBeNull();
      expect(r["sourceKind"]).toBe("article");
      expect(r["position"]).toBe(i);
      expect(r["embeddingModel"]).toBeTruthy();
      const v = jsonToEmbedding(r["embedding"] as string);
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(EMBEDDING_DIM);
    });
  }, 120_000);

  it("re-index is idempotent — delete-then-insert, no duplicates", async () => {
    await indexArticle("ws-1", { id: "art-1", content: longText(1000) });
    expect(store.rows).toHaveLength(2);
    // same content again → still 2 (old dropped, new inserted)
    await indexArticle("ws-1", { id: "art-1", content: longText(1000) });
    expect(store.rows).toHaveLength(2);
    expect(store.rows.map((r) => r["position"])).toEqual([0, 1]);
  }, 120_000);

  it("content change → chunks updated to the new content", async () => {
    await indexArticle("ws-1", { id: "art-1", content: longText(1000) });
    expect(store.rows).toHaveLength(2);
    // ~2000 words → 3 chunks (starts 0, 700, 1400)
    await indexArticle("ws-1", { id: "art-1", content: longText(2000) });
    expect(store.rows).toHaveLength(3);
    expect(store.rows.every((r) => r["articleId"] === "art-1")).toBe(true);
  }, 120_000);

  it("indexFile → chunks from extractedText (sourceKind=file, fileId set)", async () => {
    const res = await indexFile("ws-2", {
      id: "file-1",
      extractedText: longText(1000),
    });
    expect(res.chunks).toBe(2);
    store.rows.forEach((r) => {
      expect(r["sourceKind"]).toBe("file");
      expect(r["fileId"]).toBe("file-1");
      expect(r["articleId"]).toBeNull();
      expect(r["workspaceId"]).toBe("ws-2");
    });
  }, 120_000);

  it("empty content → no chunks written", async () => {
    const res = await indexArticle("ws-1", { id: "art-empty", content: "   " });
    expect(res.chunks).toBe(0);
    expect(store.rows).toHaveLength(0);
  });

  it("backfill idempotent — second pass over the same sources adds 0 net chunks", async () => {
    const sources = [
      { id: "art-a", content: longText(1000) },
      { id: "art-b", content: longText(2000) },
    ];
    for (const s of sources) await indexArticle("ws-1", s);
    const afterFirst = store.rows.length; // 2 + 3 = 5
    expect(afterFirst).toBe(5);
    for (const s of sources) await indexArticle("ws-1", s);
    expect(store.rows.length).toBe(afterFirst); // 2nd pass: net 0 new
  }, 180_000);
});
