-- CreateTable
CREATE TABLE "KbCrawl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL DEFAULT 500,
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "timeoutMs" INTEGER NOT NULL DEFAULT 900000,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "pagesFound" INTEGER NOT NULL DEFAULT 0,
    "pagesCompleted" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "currentDepth" INTEGER NOT NULL DEFAULT 0,
    "articlesCreated" INTEGER NOT NULL DEFAULT 0,
    "articlesUpdated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "initiatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KbCrawl_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbCrawl_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KbCrawlPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "crawlId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" DATETIME,
    "error" TEXT,
    "articleId" TEXT,
    CONSTRAINT "KbCrawlPage_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "KbCrawl" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "KbCrawl_workspaceId_status_idx" ON "KbCrawl"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "KbCrawl_initiatedById_idx" ON "KbCrawl"("initiatedById");

-- CreateIndex
CREATE INDEX "KbCrawlPage_crawlId_status_idx" ON "KbCrawlPage"("crawlId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KbCrawlPage_crawlId_url_key" ON "KbCrawlPage"("crawlId", "url");
