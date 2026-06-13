-- AlterTable
ALTER TABLE "MktLead" ADD COLUMN     "tagId" TEXT;

-- CreateTable
CREATE TABLE "MktTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MktTag_workspaceId_idx" ON "MktTag"("workspaceId");

-- AddForeignKey
ALTER TABLE "MktLead" ADD CONSTRAINT "MktLead_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "MktTag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktTag" ADD CONSTRAINT "MktTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
