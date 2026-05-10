/*
  Warnings:

  - Added the required column `slug` to the `Workspace` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "ChatPersona" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatPersona_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT NOT NULL,
    "chatTitle" TEXT,
    "chatSubtitle" TEXT,
    "chatAccentColor" TEXT,
    "chatLogoUrl" TEXT,
    "chatIdentityMethod" TEXT NOT NULL DEFAULT 'EMAIL_WITH_NAME',
    "chatPersonaRotation" BOOLEAN NOT NULL DEFAULT true,
    "chatAllowedEmbedOrigins" TEXT,
    "chatTimezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("createdAt", "description", "id", "name", "ownerId", "slug") SELECT "createdAt", "description", "id", "name", "ownerId", lower(replace("name", ' ', '-')) || '-' || substr("id", 1, 6) FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ChatPersona_workspaceId_position_idx" ON "ChatPersona"("workspaceId", "position");
