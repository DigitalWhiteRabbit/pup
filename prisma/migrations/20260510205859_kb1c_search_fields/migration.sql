-- AlterTable
ALTER TABLE "KbArticle" ADD COLUMN "embedding" TEXT;
ALTER TABLE "KbArticle" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "KbArticle" ADD COLUMN "embeddingUpdatedAt" DATETIME;
ALTER TABLE "KbArticle" ADD COLUMN "searchText" TEXT;
ALTER TABLE "KbArticle" ADD COLUMN "searchTextUpdatedAt" DATETIME;

-- CreateTable
CREATE TABLE "KbSearchHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "searchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "KbSearchHistory_userId_searchedAt_idx" ON "KbSearchHistory"("userId", "searchedAt");

-- CreateIndex
CREATE INDEX "KbSearchHistory_workspaceId_searchedAt_idx" ON "KbSearchHistory"("workspaceId", "searchedAt");
