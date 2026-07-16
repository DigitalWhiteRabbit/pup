-- CreateTable
CREATE TABLE "MktChannelTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MktChannelTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MktChannelTag_workspaceId_channelId_key" ON "MktChannelTag"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "MktChannelTag_workspaceId_idx" ON "MktChannelTag"("workspaceId");

-- CreateIndex
CREATE INDEX "MktChannelTag_tagId_idx" ON "MktChannelTag"("tagId");

-- AddForeignKey
ALTER TABLE "MktChannelTag" ADD CONSTRAINT "MktChannelTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktChannelTag" ADD CONSTRAINT "MktChannelTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "MktTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: перенести существующие теги с лидов в отдельную таблицу
INSERT INTO "MktChannelTag" ("id", "workspaceId", "channelId", "tagId", "createdAt")
SELECT 'cbf-' || md5("workspaceId" || '|' || "channelId"), "workspaceId", "channelId", "tagId", CURRENT_TIMESTAMP
FROM "MktLead"
WHERE "tagId" IS NOT NULL
ON CONFLICT ("workspaceId", "channelId") DO NOTHING;
