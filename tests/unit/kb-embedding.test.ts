import { describe, it, expect, beforeAll, vi } from "vitest";

// KB vector foundation smoke test (KB-vector step 1).
// The model-backed block downloads Xenova/multilingual-e5-small on first run
// (cached in node_modules/@xenova/.../.cache) — hence the long timeouts.

vi.mock("server-only", () => ({}));

import {
  chunkText,
  cosineSim,
  embeddingToJson,
  jsonToEmbedding,
  warmup,
  embedQuery,
  embedPassages,
  EMBEDDING_DIM,
} from "@/lib/services/kb/embedding.service";

describe("kb embedding — pure utils (no model)", () => {
  it("cosineSim: identical → ~1, orthogonal → 0", () => {
    const v = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
    expect(
      cosineSim(Float32Array.from([1, 0]), Float32Array.from([0, 1])),
    ).toBe(0);
  });

  it("embeddingToJson / jsonToEmbedding round-trip", () => {
    const v = Float32Array.from([0.123, -0.456, 0.789]);
    const back = jsonToEmbedding(embeddingToJson(v));
    expect(back).toBeInstanceOf(Float32Array);
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it("chunkText: overlapping windows of the configured size", () => {
    const words = Array.from({ length: 250 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(words, { size: 100, overlap: 20 });
    // step = size-overlap = 80 → starts 0, 80, 160; at i=160, 160+100>=250 → break = 3 chunks
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.split(" ").length).toBe(100);
    // overlap: last 20 words of chunk0 == first 20 words of chunk1
    const c0 = chunks[0]!.split(" ");
    const c1 = chunks[1]!.split(" ");
    expect(c0.slice(80, 100)).toEqual(c1.slice(0, 20));
  });

  it("chunkText: empty / whitespace → []", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });
});

describe("kb embedding — model-backed (downloads model on first run)", () => {
  beforeAll(async () => {
    await warmup();
  }, 300_000);

  it("embedQuery → 384-dim normalized vector", async () => {
    const v = await embedQuery("способы оплаты рекламы");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBEDDING_DIM);
    // normalized → unit length
    expect(cosineSim(v, v)).toBeCloseTo(1, 4);
  }, 120_000);

  it("embedPassages → array of 384-dim vectors", async () => {
    const vs = await embedPassages(["первый документ", "второй документ"]);
    expect(vs).toHaveLength(2);
    expect(vs[0]!.length).toBe(EMBEDDING_DIM);
    expect(vs[1]!.length).toBe(EMBEDDING_DIM);
  }, 120_000);

  it("relevant pair scores higher than irrelevant", async () => {
    const q = await embedQuery("способы оплаты рекламы");
    const [relevant, irrelevant] = await embedPassages([
      "Оплатить рекламу можно банковской картой или переводом",
      "Сегодня в Москве солнечная погода и лёгкий ветер",
    ]);
    const sRel = cosineSim(q, relevant!);
    const sIrr = cosineSim(q, irrelevant!);
    expect(sRel).toBeGreaterThan(sIrr);
  }, 120_000);
});
