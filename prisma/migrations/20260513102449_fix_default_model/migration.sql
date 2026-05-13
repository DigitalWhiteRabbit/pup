-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'copilot',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "temperature" REAL NOT NULL DEFAULT 0.3,
    "systemPrompt" TEXT,
    "greeting" TEXT,
    "guardrails" TEXT,
    "handoffThreshold" REAL NOT NULL DEFAULT 0.7,
    "autoResolve" BOOLEAN NOT NULL DEFAULT false,
    "autoFaq" BOOLEAN NOT NULL DEFAULT false,
    "autoContactNotes" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentConfig" ("autoContactNotes", "autoFaq", "autoResolve", "createdAt", "enabled", "greeting", "guardrails", "handoffThreshold", "id", "mode", "model", "systemPrompt", "temperature", "updatedAt", "workspaceId") SELECT "autoContactNotes", "autoFaq", "autoResolve", "createdAt", "enabled", "greeting", "guardrails", "handoffThreshold", "id", "mode", "model", "systemPrompt", "temperature", "updatedAt", "workspaceId" FROM "AgentConfig";
DROP TABLE "AgentConfig";
ALTER TABLE "new_AgentConfig" RENAME TO "AgentConfig";
CREATE UNIQUE INDEX "AgentConfig_workspaceId_key" ON "AgentConfig"("workspaceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
