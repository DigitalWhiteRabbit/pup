-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KbArticle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "categoryId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "sourceFileId" TEXT,
    "lastSyncedAt" DATETIME,
    "authorId" TEXT,
    "lastEditedById" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "KbArticle_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "KbFile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KbCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_KbArticle" ("authorId", "categoryId", "content", "createdAt", "id", "isPublished", "lastEditedById", "lastSyncedAt", "slug", "sourceFileId", "sourceType", "sourceUrl", "title", "updatedAt", "workspaceId") SELECT "authorId", "categoryId", "content", "createdAt", "id", "isPublished", "lastEditedById", "lastSyncedAt", "slug", "sourceFileId", "sourceType", "sourceUrl", "title", "updatedAt", "workspaceId" FROM "KbArticle";
DROP TABLE "KbArticle";
ALTER TABLE "new_KbArticle" RENAME TO "KbArticle";
CREATE INDEX "KbArticle_workspaceId_isPublished_updatedAt_idx" ON "KbArticle"("workspaceId", "isPublished", "updatedAt");
CREATE INDEX "KbArticle_categoryId_idx" ON "KbArticle"("categoryId");
CREATE INDEX "KbArticle_authorId_idx" ON "KbArticle"("authorId");
CREATE INDEX "KbArticle_sourceFileId_idx" ON "KbArticle"("sourceFileId");
CREATE UNIQUE INDEX "KbArticle_workspaceId_slug_key" ON "KbArticle"("workspaceId", "slug");
CREATE TABLE "new_KbFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KbFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_KbFile" ("id", "mimeType", "originalName", "size", "storagePath", "uploadedAt", "uploadedById", "workspaceId") SELECT "id", "mimeType", "originalName", "size", "storagePath", "uploadedAt", "uploadedById", "workspaceId" FROM "KbFile";
DROP TABLE "KbFile";
ALTER TABLE "new_KbFile" RENAME TO "KbFile";
CREATE INDEX "KbFile_workspaceId_uploadedAt_idx" ON "KbFile"("workspaceId", "uploadedAt");
CREATE INDEX "KbFile_uploadedById_idx" ON "KbFile"("uploadedById");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
