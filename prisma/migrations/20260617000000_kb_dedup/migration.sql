-- KB dedup: exact-duplicate detection fields (workspace-scoped). Additive, nullable.
ALTER TABLE "KbArticle" ADD COLUMN "normalizedUrl" TEXT;
ALTER TABLE "KbArticle" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "KbFile" ADD COLUMN "contentHash" TEXT;

CREATE INDEX "KbArticle_workspaceId_contentHash_idx" ON "KbArticle"("workspaceId", "contentHash");
CREATE INDEX "KbArticle_workspaceId_normalizedUrl_idx" ON "KbArticle"("workspaceId", "normalizedUrl");
CREATE INDEX "KbFile_workspaceId_contentHash_idx" ON "KbFile"("workspaceId", "contentHash");
