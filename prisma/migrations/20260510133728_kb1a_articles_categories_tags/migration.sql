-- CreateTable
CREATE TABLE "KbCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KbCategory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KbTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    CONSTRAINT "KbTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KbArticle" (
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
    CONSTRAINT "KbArticle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KbCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "KbArticle_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KbArticleTag" (
    "articleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("articleId", "tagId"),
    CONSTRAINT "KbArticleTag_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbArticleTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "KbTag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KbArticleVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "editedById" TEXT,
    "editedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "KbArticleVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KbArticleVersion_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "KbCategory_workspaceId_position_idx" ON "KbCategory"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "KbCategory_workspaceId_slug_key" ON "KbCategory"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "KbTag_workspaceId_idx" ON "KbTag"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "KbTag_workspaceId_name_key" ON "KbTag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "KbArticle_workspaceId_isPublished_updatedAt_idx" ON "KbArticle"("workspaceId", "isPublished", "updatedAt");

-- CreateIndex
CREATE INDEX "KbArticle_categoryId_idx" ON "KbArticle"("categoryId");

-- CreateIndex
CREATE INDEX "KbArticle_authorId_idx" ON "KbArticle"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "KbArticle_workspaceId_slug_key" ON "KbArticle"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "KbArticleTag_tagId_idx" ON "KbArticleTag"("tagId");

-- CreateIndex
CREATE INDEX "KbArticleVersion_articleId_editedAt_idx" ON "KbArticleVersion"("articleId", "editedAt");
