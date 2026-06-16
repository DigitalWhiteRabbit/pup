import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { parseUrl } from "./url-parser.service";
import { createArticle } from "./article.service";
import { validateExternalUrl } from "./url-validator";
import type { KbCrawlStatus } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type KbCrawlView = {
  id: string;
  workspaceId: string;
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  status: KbCrawlStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  pagesFound: number;
  pagesCompleted: number;
  pagesFailed: number;
  currentDepth: number;
  articlesCreated: number;
  articlesUpdated: number;
  error: string | null;
  initiatedBy: { id: string; login: string } | null;
  createdAt: Date;
};

export type KbCrawlPageView = {
  id: string;
  url: string;
  depth: number;
  status: string;
  fetchedAt: Date | null;
  error: string | null;
  articleId: string | null;
};

// ─── URL normalisation ────────────────────────────────────────────────────────

function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    // Drop fragment and normalise
    u.hash = "";
    // Remove trailing slash from path (except root)
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * True if the URL's path is under one of the excluded path prefixes (segment
 * boundary aware: "/de" excludes /de and /de/x but NOT /design). Used to skip
 * unwanted locales/sections during a crawl. Safe prefix matching — no regex.
 */
function pathIsExcluded(url: string, excludePaths?: string[]): boolean {
  if (!excludePaths || excludePaths.length === 0) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  for (const raw of excludePaths) {
    let p = raw.trim();
    if (!p) continue;
    if (!p.startsWith("/")) p = "/" + p;
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}

// ─── startCrawl ───────────────────────────────────────────────────────────────

export async function startCrawl(
  input: {
    workspaceId: string;
    startUrl: string;
    maxPages?: number;
    maxDepth?: number;
    timeoutMs?: number;
    categoryId?: string;
    tagIds?: string[];
    excludePaths?: string[];
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{ crawlId: string }> {
  const membership = await checkMembership(input.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  // Validate URL — SSRF protection
  try {
    await validateExternalUrl(input.startUrl);
  } catch (err: unknown) {
    throw new ApiError(
      (err as Error).message || "Некорректный startUrl",
      "INVALID_URL",
      400,
    );
  }

  const crawl = await db.kbCrawl.create({
    data: {
      workspaceId: input.workspaceId,
      startUrl: input.startUrl,
      maxPages: input.maxPages ?? 500,
      maxDepth: input.maxDepth ?? 5,
      timeoutMs: input.timeoutMs ?? 900000,
      initiatedById: userId,
      status: "PENDING",
    },
  });

  void logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "KB_CRAWL_STARTED",
    entityType: "KbCrawl",
    entityId: crawl.id,
    summary: generateSummary("KB_CRAWL_STARTED", { sourceUrl: input.startUrl }),
    metadata: {
      startUrl: input.startUrl,
      maxPages: crawl.maxPages,
      maxDepth: crawl.maxDepth,
    },
  });

  // Fire-and-forget
  void runCrawl(crawl.id, input.workspaceId, userId, userRole, {
    categoryId: input.categoryId,
    tagIds: input.tagIds,
    excludePaths: input.excludePaths,
  });

  return { crawlId: crawl.id };
}

// ─── runCrawl (internal) ──────────────────────────────────────────────────────

async function runCrawl(
  crawlId: string,
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  opts: { categoryId?: string; tagIds?: string[]; excludePaths?: string[] },
): Promise<void> {
  const crawlRecord = await db.kbCrawl.findUnique({ where: { id: crawlId } });
  if (!crawlRecord) return;

  await db.kbCrawl.update({
    where: { id: crawlId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const startedAt = Date.now();
  const { startUrl, maxPages, maxDepth, timeoutMs } = crawlRecord;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: startUrl, depth: 0 },
  ];

  let pagesCompleted = 0;
  let pagesFailed = 0;
  let articlesCreated = 0;
  let maxDepthReached = 0;

  // Pre-load existing sourceUrls for this workspace to avoid duplicates
  const existingUrls = new Set<string>(
    (
      await db.kbArticle.findMany({
        where: { workspaceId, sourceType: "URL", sourceUrl: { not: null } },
        select: { sourceUrl: true },
      })
    )
      .map((a) => a.sourceUrl!)
      .filter(Boolean),
  );

  try {
    while (queue.length > 0) {
      // Check cancellation
      const currentStatus = await db.kbCrawl.findUnique({
        where: { id: crawlId },
        select: { status: true },
      });
      if (
        currentStatus?.status === "CANCELLED" ||
        currentStatus?.status === "FAILED"
      ) {
        return;
      }

      // Timeout check
      if (Date.now() - startedAt > timeoutMs) {
        await db.kbCrawl.update({
          where: { id: crawlId },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            error: "Достигнут лимит времени",
          },
        });
        return;
      }

      // Pages limit
      if (pagesCompleted >= maxPages) break;

      const item = queue.shift()!;

      // Depth limit
      if (item.depth > maxDepth) continue;

      // Normalise and deduplicate
      const normUrl = normalizeUrl(item.url, startUrl);
      if (!normUrl) continue;
      if (visited.has(normUrl)) continue;
      if (!sameOrigin(normUrl, startUrl)) continue;
      if (pathIsExcluded(normUrl, opts.excludePaths)) continue;
      visited.add(normUrl);

      maxDepthReached = Math.max(maxDepthReached, item.depth);

      // Create page record
      const page = await db.kbCrawlPage.create({
        data: {
          crawlId,
          url: normUrl,
          depth: item.depth,
          status: "pending",
        },
      });

      // Update pagesFound
      await db.kbCrawl.update({
        where: { id: crawlId },
        data: {
          pagesFound: visited.size,
          currentDepth: maxDepthReached,
        },
      });

      // Fetch and parse
      try {
        const result = await parseUrl(normUrl, { timeout: 15000 });

        // Re-check cancellation after the (slow) fetch so a cancel mid-page is
        // responsive and we don't create an article for an aborted crawl.
        // return (not break) — must not overwrite CANCELLED with COMPLETED.
        const midStatus = await db.kbCrawl.findUnique({
          where: { id: crawlId },
          select: { status: true },
        });
        if (
          midStatus?.status === "CANCELLED" ||
          midStatus?.status === "FAILED"
        ) {
          await db.kbCrawlPage.update({
            where: { id: page.id },
            data: { status: "skipped", fetchedAt: new Date() },
          });
          return;
        }

        // Check duplicate by sourceUrl (including newly discovered in this run)
        if (existingUrls.has(normUrl)) {
          await db.kbCrawlPage.update({
            where: { id: page.id },
            data: { status: "skipped", fetchedAt: new Date() },
          });
        } else {
          // Create article
          const article = await createArticle(
            {
              workspaceId,
              title: result.title,
              content: result.content,
              categoryId: opts.categoryId ?? null,
              tagIds: opts.tagIds,
              sourceType: "URL",
              sourceUrl: normUrl,
              lastSyncedAt: new Date(),
            },
            userId,
            userRole,
          );

          existingUrls.add(normUrl);
          articlesCreated++;

          await db.kbCrawlPage.update({
            where: { id: page.id },
            data: {
              status: "completed",
              fetchedAt: new Date(),
              articleId: article.id,
            },
          });
        }

        pagesCompleted++;

        // Enqueue child links (same-origin, not visited, cap queue size)
        if (item.depth < maxDepth && queue.length < maxPages * 3) {
          for (const link of result.links) {
            const norm = normalizeUrl(link, startUrl);
            if (
              norm &&
              sameOrigin(norm, startUrl) &&
              !visited.has(norm) &&
              !pathIsExcluded(norm, opts.excludePaths)
            ) {
              queue.push({ url: norm, depth: item.depth + 1 });
              if (queue.length >= maxPages * 3) break;
            }
          }
        }
      } catch (err) {
        pagesFailed++;
        await db.kbCrawlPage.update({
          where: { id: page.id },
          data: {
            status: "failed",
            fetchedAt: new Date(),
            error: (err as Error).message ?? "Parse error",
          },
        });
      }

      // Update progress stats
      await db.kbCrawl.update({
        where: { id: crawlId },
        data: {
          pagesCompleted,
          pagesFailed,
          articlesCreated,
          currentDepth: maxDepthReached,
        },
      });
    }

    await db.kbCrawl.update({
      where: { id: crawlId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    void logActivity({
      workspaceId,
      actorId: userId,
      action: "KB_CRAWL_COMPLETED",
      entityType: "KbCrawl",
      entityId: crawlId,
      summary: generateSummary("KB_CRAWL_COMPLETED", {
        sourceUrl: startUrl,
        kbArticleTitle: String(articlesCreated),
      }),
      metadata: { articlesCreated, pagesCompleted, pagesFailed },
    });
  } catch (err: unknown) {
    await db.kbCrawl.update({
      where: { id: crawlId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: (err as Error).message ?? "Unknown error",
      },
    });

    void logActivity({
      workspaceId,
      actorId: userId,
      action: "KB_CRAWL_FAILED",
      entityType: "KbCrawl",
      entityId: crawlId,
      summary: generateSummary("KB_CRAWL_FAILED", { sourceUrl: startUrl }),
      metadata: { error: (err as Error).message },
    });
  }
}

// ─── cancelCrawl ──────────────────────────────────────────────────────────────

export async function cancelCrawl(
  crawlId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const crawl = await db.kbCrawl.findUnique({ where: { id: crawlId } });
  if (!crawl) throw new ApiError("Crawl не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(crawl.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  if (crawl.status !== "RUNNING" && crawl.status !== "PENDING") {
    throw new ApiError(
      "Crawl нельзя отменить в текущем статусе",
      "INVALID_STATE",
      400,
    );
  }

  await db.kbCrawl.update({
    where: { id: crawlId },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  void logActivity({
    workspaceId: crawl.workspaceId,
    actorId: userId,
    action: "KB_CRAWL_CANCELLED",
    entityType: "KbCrawl",
    entityId: crawlId,
    summary: generateSummary("KB_CRAWL_CANCELLED", {
      sourceUrl: crawl.startUrl,
    }),
    metadata: {},
  });
}

// ─── getCrawlStatus ───────────────────────────────────────────────────────────

export async function getCrawlStatus(
  crawlId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbCrawlView & { pages: KbCrawlPageView[] }> {
  const crawl = await db.kbCrawl.findUnique({
    where: { id: crawlId },
    include: {
      initiatedBy: { select: { id: true, login: true } },
      pages: { orderBy: { fetchedAt: "asc" }, take: 100 },
    },
  });
  if (!crawl) throw new ApiError("Crawl не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(crawl.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  return {
    id: crawl.id,
    workspaceId: crawl.workspaceId,
    startUrl: crawl.startUrl,
    maxPages: crawl.maxPages,
    maxDepth: crawl.maxDepth,
    timeoutMs: crawl.timeoutMs,
    status: crawl.status,
    startedAt: crawl.startedAt,
    completedAt: crawl.completedAt,
    pagesFound: crawl.pagesFound,
    pagesCompleted: crawl.pagesCompleted,
    pagesFailed: crawl.pagesFailed,
    currentDepth: crawl.currentDepth,
    articlesCreated: crawl.articlesCreated,
    articlesUpdated: crawl.articlesUpdated,
    error: crawl.error,
    initiatedBy: crawl.initiatedBy,
    createdAt: crawl.createdAt,
    pages: crawl.pages.map((p) => ({
      id: p.id,
      url: p.url,
      depth: p.depth,
      status: p.status,
      fetchedAt: p.fetchedAt,
      error: p.error,
      articleId: p.articleId,
    })),
  };
}

// ─── listCrawls ───────────────────────────────────────────────────────────────

export async function listCrawls(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  opts?: { status?: KbCrawlStatus },
): Promise<KbCrawlView[]> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const crawls = await db.kbCrawl.findMany({
    where: { workspaceId, ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { initiatedBy: { select: { id: true, login: true } } },
  });

  return crawls.map((c) => ({
    id: c.id,
    workspaceId: c.workspaceId,
    startUrl: c.startUrl,
    maxPages: c.maxPages,
    maxDepth: c.maxDepth,
    timeoutMs: c.timeoutMs,
    status: c.status,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    pagesFound: c.pagesFound,
    pagesCompleted: c.pagesCompleted,
    pagesFailed: c.pagesFailed,
    currentDepth: c.currentDepth,
    articlesCreated: c.articlesCreated,
    articlesUpdated: c.articlesUpdated,
    error: c.error,
    initiatedBy: c.initiatedBy,
    createdAt: c.createdAt,
  }));
}
