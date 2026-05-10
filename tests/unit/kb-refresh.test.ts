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

const mockFindUnique = vi.fn();
const mockVersionCreate = vi.fn();
const mockArticleUpdate = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    kbArticle: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockArticleUpdate(...a),
    },
    kbArticleVersion: { create: (...a: unknown[]) => mockVersionCreate(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("OWNER"),
}));

vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn(),
  generateSummary: vi.fn().mockReturnValue("summary"),
}));

const mockParseUrl = vi.fn();
vi.mock("@/lib/services/kb/url-parser.service", () => ({
  parseUrl: (...a: unknown[]) => mockParseUrl(...a),
}));

const baseArticle = {
  id: "art1",
  workspaceId: "ws1",
  title: "Old Title",
  slug: "old",
  content: "Old content",
  sourceType: "URL",
  sourceUrl: "https://example.com/page",
  lastSyncedAt: null,
  categoryId: null,
  category: null,
  tags: [],
  author: null,
  lastEditedBy: null,
  isPublished: true,
  _count: { versions: 0 },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeParseResult = (title: string, content: string) => ({
  title,
  content,
  url: "https://example.com/page",
  finalUrl: "https://example.com/page",
  links: [],
  metadata: {
    fetchedAt: new Date(),
    statusCode: 200,
    contentType: "text/html",
  },
});

describe("refreshFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue(baseArticle);
  });

  it("returns changed=false if content identical", async () => {
    mockParseUrl.mockResolvedValue(makeParseResult("Old Title", "Old content"));
    const { refreshFromUrl } =
      await import("@/lib/services/kb/article.service");
    const result = await refreshFromUrl("art1", "user1", "ADMIN", true);
    expect(result.changed).toBe(false);
    expect(result.newVersion).toBeNull();
  });

  it("returns diff with addedLines when content changed", async () => {
    mockParseUrl.mockResolvedValue(
      makeParseResult("Old Title", "Old content\nNew line"),
    );
    const { refreshFromUrl } =
      await import("@/lib/services/kb/article.service");
    const result = await refreshFromUrl("art1", "user1", "ADMIN", true);
    expect(result.changed).toBe(true);
    expect(result.diff.addedLines).toBeGreaterThan(0);
    expect(result.newVersion).toBeNull();
  });

  it("detects title change", async () => {
    mockParseUrl.mockResolvedValue(makeParseResult("New Title", "Old content"));
    const { refreshFromUrl } =
      await import("@/lib/services/kb/article.service");
    const result = await refreshFromUrl("art1", "user1", "ADMIN", true);
    expect(result.changed).toBe(true);
    expect(result.diff.titleChanged).toBe(true);
    expect(result.diff.newTitle).toBe("New Title");
  });

  it("preview=false creates version and returns newVersion", async () => {
    mockParseUrl.mockResolvedValue(makeParseResult("New Title", "New content"));
    const updatedArticle = {
      ...baseArticle,
      title: "New Title",
      content: "New content",
    };
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        kbArticleVersion: { create: mockVersionCreate },
        kbArticle: { update: vi.fn().mockResolvedValue(updatedArticle) },
      }),
    );
    const { refreshFromUrl } =
      await import("@/lib/services/kb/article.service");
    const result = await refreshFromUrl("art1", "user1", "ADMIN", false);
    expect(result.changed).toBe(true);
    expect(result.newVersion).not.toBeNull();
    expect(mockVersionCreate).toHaveBeenCalled();
  });

  it("throws ApiError if article has no sourceUrl", async () => {
    mockFindUnique.mockResolvedValue({
      ...baseArticle,
      sourceType: "MANUAL",
      sourceUrl: null,
    });
    const { refreshFromUrl } =
      await import("@/lib/services/kb/article.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(
      refreshFromUrl("art1", "user1", "ADMIN", true),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
