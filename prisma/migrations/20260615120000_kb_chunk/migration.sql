-- CreateTable
CREATE TABLE "KbChunk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "articleId" TEXT,
    "fileId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" TEXT,
    "embeddingModel" TEXT,
    "tokenCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KbChunk_workspaceId_idx" ON "KbChunk"("workspaceId");

-- CreateIndex
CREATE INDEX "KbChunk_articleId_idx" ON "KbChunk"("articleId");

-- CreateIndex
CREATE INDEX "KbChunk_fileId_idx" ON "KbChunk"("fileId");

-- AddForeignKey
ALTER TABLE "KbChunk" ADD CONSTRAINT "KbChunk_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbChunk" ADD CONSTRAINT "KbChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "KbFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
