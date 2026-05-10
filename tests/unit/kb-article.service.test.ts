import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ─── Mock db ──────────────────────────────────────────────────────────────────

const mockArticleCreate = vi.fn();
const mockArticleFindUnique = vi.fn();
const mockArticleFindFirst = vi.fn();
const mockArticleFindMany = vi.fn();
const mockArticleCount = vi.fn();
const mockArticleUpdate = vi.fn();
const mockArticleDelete = vi.fn();
const mockArticleAggregate = vi.fn();
const mockVersionCreate = vi.fn();
const mockVersionFindMany = vi.fn();
const mockVersionFindUnique = vi.fn();
const mockTagDeleteMany = vi.fn();
const mockTagCreateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    kbArticle: {
      create: (...a: unknown[]) => mockArticleCreate(...a),
      findUnique: (...a: unknown[]) => mockArticleFindUnique(...a),
      findFirst: (...a: unknown[]) => mockArticleFindFirst(...a),
      findMany: (...a: unknown[]) => mockArticleFindMany(...a),
      count: (...a: unknown[]) => mockArticleCount(...a),
      update: (...a: unknown[]) => mockArticleUpdate(...a),
      delete: (...a: unknown[]) => mockArticleDelete(...a),
      aggregate: (...a: unknown[]) => mockArticleAggregate(...a),
    },
    kbArticleVersion: {
      create: (...a: unknown[]) => mockVersionCreate(...a),
      findMany: (...a: unknown[]) => mockVersionFindMany(...a),
      findUnique: (...a: unknown[]) => mockVersionFindUnique(...a),
    },
    kbArticleTag: {
      deleteMany: (...a: unknown[]) => mockTagDeleteMany(...a),
      createMany: (...a: unknown[]) => mockTagCreateMany(...a),
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("MEMBER"),
}));

vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  generateSummary: vi.fn().mockReturnValue("summary"),
}));

vi.mock("slugify", () => ({
  default: (_str: string, _opts?: unknown) => {
    // Simple mock: lowercase + replace spaces with dashes
    return _str
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  },
}));

import {
  createArticle,
  updateArticle,
  listArticles,
  restoreArticleVersion,
} from "@/lib/services/kb/article.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockArticle = {
  id: "art-1",
  workspaceId: "ws-1",
  title: "Test Article",
  slug: "test-article",
  content: "# Hello world",
  categoryId: null,
  category: null,
  tags: [],
  author: { id: "u-1", login: "admin" },
  lastEditedBy: null,
  isPublished: true,
  _count: { versions: 1 },
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  sourceType: "MANUAL" as const,
  workspace: { id: "ws-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no slug collision
  mockArticleFindFirst.mockResolvedValue(null);
  // Default transaction: runs the callback
  mockTransaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn === "function")
      return fn({
        kbArticle: {
          create: mockArticleCreate,
          update: mockArticleUpdate,
        },
        kbArticleVersion: { create: mockVersionCreate },
        kbArticleTag: {
          deleteMany: mockTagDeleteMany,
          createMany: mockTagCreateMany,
        },
      });
    // Array of promises (reorderCategories)
    if (Array.isArray(fn)) return Promise.all(fn);
    return fn;
  });
});

// ─── createArticle ────────────────────────────────────────────────────────────

describe("createArticle", () => {
  it("creates article and first version", async () => {
    mockArticleCreate.mockResolvedValue(mockArticle);
    mockVersionCreate.mockResolvedValue({ id: "v-1" });

    const result = await createArticle(
      { workspaceId: "ws-1", title: "Test Article", content: "# Hello" },
      "u-1",
      "ADMIN",
    );

    expect(mockArticleCreate).toHaveBeenCalledOnce();
    expect(mockVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: "Создание статьи" }),
      }),
    );
    expect(result.title).toBe("Test Article");
  });

  it("generates slug from title (ASCII)", async () => {
    mockArticleCreate.mockResolvedValue({
      ...mockArticle,
      slug: "test-article",
    });
    mockVersionCreate.mockResolvedValue({ id: "v-1" });

    await createArticle(
      { workspaceId: "ws-1", title: "Test Article", content: "" },
      "u-1",
      "ADMIN",
    );

    expect(mockArticleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "test-article" }),
      }),
    );
  });

  it("adds suffix on slug collision", async () => {
    // First call: collision exists, second: no collision
    mockArticleFindFirst
      .mockResolvedValueOnce({ id: "other" })
      .mockResolvedValueOnce(null);
    mockArticleCreate.mockResolvedValue({
      ...mockArticle,
      slug: "test-article-2",
    });
    mockVersionCreate.mockResolvedValue({ id: "v-1" });

    await createArticle(
      { workspaceId: "ws-1", title: "Test Article", content: "" },
      "u-1",
      "ADMIN",
    );

    expect(mockArticleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "test-article-2" }),
      }),
    );
  });

  it("creates tag relations via tags create", async () => {
    const tagIds = ["tag-1", "tag-2"];
    mockArticleCreate.mockResolvedValue({
      ...mockArticle,
      tags: [{ tag: { id: "tag-1", name: "A", color: "#f00" } }],
    });
    mockVersionCreate.mockResolvedValue({ id: "v-1" });

    await createArticle(
      { workspaceId: "ws-1", title: "Test", content: "", tagIds },
      "u-1",
      "ADMIN",
    );

    expect(mockArticleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: { create: [{ tagId: "tag-1" }, { tagId: "tag-2" }] },
        }),
      }),
    );
  });
});

// ─── updateArticle ────────────────────────────────────────────────────────────

describe("updateArticle", () => {
  it("creates version from current state BEFORE update", async () => {
    mockArticleFindUnique.mockResolvedValue(mockArticle);
    mockArticleUpdate.mockResolvedValue({ ...mockArticle, title: "Updated" });

    await updateArticle(
      "art-1",
      { title: "Updated", content: "new" },
      "u-1",
      "ADMIN",
    );

    expect(mockVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Test Article", // original title
          content: "# Hello world", // original content
          articleId: "art-1",
        }),
      }),
    );
  });

  it("updates article fields", async () => {
    mockArticleFindUnique.mockResolvedValue(mockArticle);
    mockArticleUpdate.mockResolvedValue({ ...mockArticle, title: "New Title" });

    const result = await updateArticle(
      "art-1",
      { title: "New Title" },
      "u-1",
      "ADMIN",
    );

    expect(mockArticleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "art-1" },
        data: expect.objectContaining({ title: "New Title" }),
      }),
    );
    expect(result.title).toBe("New Title");
  });

  it("recreates tag relations when tagIds provided", async () => {
    mockArticleFindUnique.mockResolvedValue(mockArticle);
    mockArticleUpdate.mockResolvedValue(mockArticle);

    await updateArticle("art-1", { tagIds: ["tag-3"] }, "u-1", "ADMIN");

    expect(mockTagDeleteMany).toHaveBeenCalledWith({
      where: { articleId: "art-1" },
    });
    expect(mockTagCreateMany).toHaveBeenCalledWith({
      data: [{ articleId: "art-1", tagId: "tag-3" }],
    });
  });

  it("calls logActivity", async () => {
    const { logActivity } = await import("@/lib/services/logger.service");
    mockArticleFindUnique.mockResolvedValue(mockArticle);
    mockArticleUpdate.mockResolvedValue(mockArticle);

    await updateArticle("art-1", { title: "X" }, "u-1", "ADMIN");

    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "KB_ARTICLE_UPDATED" }),
    );
  });
});

// ─── listArticles ─────────────────────────────────────────────────────────────

describe("listArticles", () => {
  beforeEach(() => {
    mockArticleFindMany.mockResolvedValue([mockArticle]);
    mockArticleCount.mockResolvedValue(1);
    mockTransaction.mockImplementation(async (arr: unknown) => {
      if (Array.isArray(arr)) return Promise.all(arr);
      return arr;
    });
  });

  it("filters by categoryId", async () => {
    await listArticles("ws-1", "u-1", "ADMIN", { categoryId: "cat-1" });

    expect(mockArticleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ categoryId: "cat-1" }),
      }),
    );
  });

  it("filters by tagIds", async () => {
    await listArticles("ws-1", "u-1", "ADMIN", { tagIds: ["tag-1"] });

    expect(mockArticleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { some: { tagId: { in: ["tag-1"] } } },
        }),
      }),
    );
  });

  it("filters by isPublished", async () => {
    await listArticles("ws-1", "u-1", "ADMIN", { isPublished: false });

    expect(mockArticleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isPublished: false }),
      }),
    );
  });

  it("filters by search (title contains)", async () => {
    await listArticles("ws-1", "u-1", "ADMIN", { search: "Hello" });

    expect(mockArticleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: { contains: "Hello" } }),
      }),
    );
  });

  it("paginates correctly", async () => {
    await listArticles("ws-1", "u-1", "ADMIN", { page: 3, pageSize: 10 });

    expect(mockArticleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });
});

// ─── restoreArticleVersion ────────────────────────────────────────────────────

describe("restoreArticleVersion", () => {
  it("applies version content to article", async () => {
    mockVersionFindUnique.mockResolvedValue({
      id: "v-1",
      articleId: "art-1",
      title: "Old Title",
      content: "Old content",
      editedAt: new Date("2026-01-01"),
      article: {
        workspaceId: "ws-1",
        title: "Current",
        content: "Current content",
      },
    });
    mockArticleUpdate.mockResolvedValue({
      ...mockArticle,
      title: "Old Title",
      content: "Old content",
    });

    await restoreArticleVersion("art-1", "v-1", "u-1", "ADMIN");

    expect(mockArticleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Old Title",
          content: "Old content",
        }),
      }),
    );
  });

  it("creates new version with 'Восстановлено...' reason", async () => {
    mockVersionFindUnique.mockResolvedValue({
      id: "v-1",
      articleId: "art-1",
      title: "Old Title",
      content: "Old content",
      editedAt: new Date("2026-01-01"),
      article: {
        workspaceId: "ws-1",
        title: "Current",
        content: "Current content",
      },
    });
    mockArticleUpdate.mockResolvedValue(mockArticle);

    await restoreArticleVersion("art-1", "v-1", "u-1", "ADMIN");

    expect(mockVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: expect.stringContaining("Восстановлено"),
        }),
      }),
    );
  });
});
