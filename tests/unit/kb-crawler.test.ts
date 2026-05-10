import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-error", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(m: string, c: string, s = 400) {
      super(m);
      this.code = c;
      this.status = s;
    }
  },
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCrawlCreate = vi.fn();
const mockCrawlUpdate = vi.fn();
const mockCrawlFindUnique = vi.fn();
const mockCrawlFindMany = vi.fn();
const mockCrawlUpdateMany = vi.fn();
const mockCrawlPageCreate = vi.fn();
const mockCrawlPageUpdate = vi.fn();
const mockArticleFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    kbCrawl: {
      create: (...a: unknown[]) => mockCrawlCreate(...a),
      update: (...a: unknown[]) => mockCrawlUpdate(...a),
      findUnique: (...a: unknown[]) => mockCrawlFindUnique(...a),
      findMany: (...a: unknown[]) => mockCrawlFindMany(...a),
      updateMany: (...a: unknown[]) => mockCrawlUpdateMany(...a),
    },
    kbCrawlPage: {
      create: (...a: unknown[]) => mockCrawlPageCreate(...a),
      update: (...a: unknown[]) => mockCrawlPageUpdate(...a),
    },
    kbArticle: {
      findMany: (...a: unknown[]) => mockArticleFindMany(...a),
    },
  },
}));

vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("OWNER"),
}));

vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn(),
  generateSummary: vi.fn().mockReturnValue("summary"),
}));

vi.mock("@/lib/services/kb/url-parser.service", () => ({
  parseUrl: vi.fn().mockResolvedValue({
    title: "Test Page",
    content: "Content",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    links: [],
    metadata: {
      fetchedAt: new Date(),
      statusCode: 200,
      contentType: "text/html",
    },
  }),
}));

vi.mock("@/lib/services/kb/article.service", () => ({
  createArticle: vi.fn().mockResolvedValue({ id: "art1", title: "Test Page" }),
}));

// ─── startCrawl tests ─────────────────────────────────────────────────────────

describe("startCrawl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCrawlCreate.mockResolvedValue({
      id: "crawl1",
      workspaceId: "ws1",
      startUrl: "https://example.com",
      maxPages: 500,
      maxDepth: 5,
      timeoutMs: 900000,
      status: "PENDING",
    });
  });

  it("creates KbCrawl with PENDING status", async () => {
    const { startCrawl } = await import("@/lib/services/kb/crawler.service");
    const result = await startCrawl(
      { workspaceId: "ws1", startUrl: "https://example.com" },
      "user1",
      "ADMIN",
    );
    expect(mockCrawlCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING" }),
      }),
    );
    expect(result.crawlId).toBe("crawl1");
  });

  it("applies default limits when not provided", async () => {
    const { startCrawl } = await import("@/lib/services/kb/crawler.service");
    await startCrawl(
      { workspaceId: "ws1", startUrl: "https://example.com" },
      "user1",
      "ADMIN",
    );
    expect(mockCrawlCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          maxPages: 500,
          maxDepth: 5,
          timeoutMs: 900000,
        }),
      }),
    );
  });

  it("throws on invalid startUrl", async () => {
    const { startCrawl } = await import("@/lib/services/kb/crawler.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(
      startCrawl(
        { workspaceId: "ws1", startUrl: "not-a-url" },
        "user1",
        "ADMIN",
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

// ─── cancelCrawl ──────────────────────────────────────────────────────────────

describe("cancelCrawl", () => {
  it("cancels a RUNNING crawl", async () => {
    mockCrawlFindUnique.mockResolvedValue({
      id: "crawl1",
      workspaceId: "ws1",
      status: "RUNNING",
      startUrl: "https://example.com",
    });
    mockCrawlUpdate.mockResolvedValue({});

    const { cancelCrawl } = await import("@/lib/services/kb/crawler.service");
    await cancelCrawl("crawl1", "user1", "ADMIN");
    expect(mockCrawlUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("throws if crawl already COMPLETED", async () => {
    mockCrawlFindUnique.mockResolvedValue({
      id: "crawl1",
      workspaceId: "ws1",
      status: "COMPLETED",
      startUrl: "https://example.com",
    });
    const { cancelCrawl } = await import("@/lib/services/kb/crawler.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(
      cancelCrawl("crawl1", "user1", "ADMIN"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
