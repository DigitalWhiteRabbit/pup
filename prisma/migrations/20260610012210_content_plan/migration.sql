-- CreateTable
CREATE TABLE "ContentCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "visualStatus" TEXT NOT NULL DEFAULT 'NONE',
    "publishDate" DATETIME,
    "visualBrief" TEXT,
    "visualLink" TEXT,
    "text" TEXT,
    "workComment" TEXT,
    "adminComment" TEXT,
    "publishedUrl" TEXT,
    "publishedExternalId" TEXT,
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "proofChecked" BOOLEAN NOT NULL DEFAULT false,
    "visualApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContentCard_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentCard_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ContentCard_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentMedia_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ContentCard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentCardHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentCardHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ContentCard" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentCardHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ContentCard_workspaceId_idx" ON "ContentCard"("workspaceId");

-- CreateIndex
CREATE INDEX "ContentCard_status_idx" ON "ContentCard"("status");

-- CreateIndex
CREATE INDEX "ContentCard_publishDate_idx" ON "ContentCard"("publishDate");

-- CreateIndex
CREATE INDEX "ContentMedia_cardId_idx" ON "ContentMedia"("cardId");

-- CreateIndex
CREATE INDEX "ContentCardHistory_cardId_createdAt_idx" ON "ContentCardHistory"("cardId", "createdAt");
