import { describe, it, expect, beforeEach, vi } from "vitest";

// KB-vector step 4 — agent grounding (hybrid vector + keyword fallback).
// Pure logic test: mock the two retrieval paths + db; no model, no network.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  searchKbChunks: vi.fn(),
  searchArticles: vi.fn(),
  kbFileFindMany: vi.fn(),
}));

vi.mock("@/lib/services/kb/vector-search.service", () => ({
  searchKbChunks: mocks.searchKbChunks,
}));
vi.mock("@/lib/services/kb/search.service", () => ({
  searchArticles: mocks.searchArticles,
}));
vi.mock("@/lib/db", () => ({
  db: { kbFile: { findMany: mocks.kbFileFindMany } },
}));

import { fetchKnowledgeContext } from "@/lib/services/agent/agent.service";

const customer = (content: string) => [{ authorType: "CUSTOMER", content }];

describe("agent fetchKnowledgeContext — hybrid grounding", () => {
  beforeEach(() => {
    mocks.searchKbChunks.mockReset();
    mocks.searchArticles.mockReset();
    mocks.kbFileFindMany.mockReset();
    mocks.searchArticles.mockResolvedValue({ data: [] });
    mocks.kbFileFindMany.mockResolvedValue([]);
  });

  it("vector path: builds context from chunks (no keyword needed)", async () => {
    mocks.searchKbChunks.mockResolvedValue([
      {
        chunkText: "Оплата картой и переводом.",
        sourceKind: "article",
        articleId: "a1",
        fileId: null,
        title: "Оплата",
        score: 0.9,
      },
      {
        chunkText: "Минимальный бюджет 1000₽.",
        sourceKind: "article",
        articleId: "a2",
        fileId: null,
        title: "Бюджет",
        score: 0.85,
      },
    ]);

    const ctx = await fetchKnowledgeContext("ws-1", customer("как оплатить?"));

    expect(ctx).toContain("<knowledge_base>");
    expect(ctx).toContain("Оплата картой и переводом.");
    expect(ctx).toContain("## Оплата");
    // ≥ HYBRID_MIN_VECTOR_HITS (2) → keyword path NOT invoked
    expect(mocks.searchArticles).not.toHaveBeenCalled();
  });

  it("empty vector → keyword fallback still yields a non-empty context", async () => {
    mocks.searchKbChunks.mockResolvedValue([]);
    mocks.searchArticles.mockResolvedValue({
      data: [{ title: "FAQ оплата", contentPreview: "Можно картой." }],
    });

    const ctx = await fetchKnowledgeContext("ws-1", customer("как оплатить?"));

    expect(mocks.searchArticles).toHaveBeenCalled();
    expect(ctx).toContain("<knowledge_base>");
    expect(ctx).toContain("## FAQ оплата");
    expect(ctx).toContain("Можно картой.");
  });

  it("hybrid: 1 vector hit (< min) → augmented with keyword parts", async () => {
    mocks.searchKbChunks.mockResolvedValue([
      {
        chunkText: "Семантический чанк.",
        sourceKind: "article",
        articleId: "a1",
        fileId: null,
        title: "Vec",
        score: 0.88,
      },
    ]);
    mocks.searchArticles.mockResolvedValue({
      data: [{ title: "Keyword статья", contentPreview: "Ключевой текст." }],
    });

    const ctx = await fetchKnowledgeContext("ws-1", customer("вопрос"));

    expect(mocks.searchArticles).toHaveBeenCalled();
    expect(ctx).toContain("Семантический чанк.");
    expect(ctx).toContain("Keyword статья");
  });

  it("file chunks get a 'Документ:' heading", async () => {
    mocks.searchKbChunks.mockResolvedValue([
      {
        chunkText: "Из документа.",
        sourceKind: "file",
        articleId: null,
        fileId: "f1",
        title: "guide.pdf",
        score: 0.9,
      },
      {
        chunkText: "Ещё из документа.",
        sourceKind: "file",
        articleId: null,
        fileId: "f2",
        title: "rules.pdf",
        score: 0.86,
      },
    ]);

    const ctx = await fetchKnowledgeContext("ws-1", customer("вопрос"));
    expect(ctx).toContain("## Документ: guide.pdf");
  });

  it("nothing anywhere → empty string (no knowledge_base block)", async () => {
    mocks.searchKbChunks.mockResolvedValue([]);
    const ctx = await fetchKnowledgeContext("ws-1", customer("вопрос"));
    expect(ctx).toBe("");
  });

  it("no customer message → empty string", async () => {
    const ctx = await fetchKnowledgeContext("ws-1", [
      { authorType: "AGENT", content: "привет" },
    ]);
    expect(ctx).toBe("");
    expect(mocks.searchKbChunks).not.toHaveBeenCalled();
  });
});
