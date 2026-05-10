-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "externalId" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Customer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "slaDeadline" DATETIME,
    "slaBreached" BOOLEAN NOT NULL DEFAULT false,
    "internalCreatorId" TEXT,
    "customerId" TEXT,
    "assigneeId" TEXT,
    "assignedAt" DATETIME,
    "needsHumanHelp" BOOLEAN NOT NULL DEFAULT false,
    "helpRequestedAt" DATETIME,
    "agentConfidence" REAL,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Ticket_internalCreatorId_fkey" FOREIGN KEY ("internalCreatorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Ticket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "managerAuthorId" TEXT,
    "customerAuthorId" TEXT,
    "content" TEXT NOT NULL,
    "systemAction" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TicketMessage_managerAuthorId_fkey" FOREIGN KEY ("managerAuthorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TicketMessage_customerAuthorId_fkey" FOREIGN KEY ("customerAuthorId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedByCustomerId" TEXT,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TicketAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TicketAttachment_uploadedByCustomerId_fkey" FOREIGN KEY ("uploadedByCustomerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "login" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "telegramChatId" TEXT,
    "tgNotifyAssign" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyComment" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyMove" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyProject" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTaskDeleted" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyMemberRemoved" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyWorkspaceDeleted" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyRoleChanged" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyTicketAssigned" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTicketMessage" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTicketSlaBreached" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_User" ("createdAt", "email", "id", "isActive", "lastSeenAt", "login", "password", "role", "telegramChatId", "tgNotifyAssign", "tgNotifyComment", "tgNotifyMemberRemoved", "tgNotifyMove", "tgNotifyProject", "tgNotifyRoleChanged", "tgNotifyTaskDeleted", "tgNotifyWorkspaceDeleted") SELECT "createdAt", "email", "id", "isActive", "lastSeenAt", "login", "password", "role", "telegramChatId", "tgNotifyAssign", "tgNotifyComment", "tgNotifyMemberRemoved", "tgNotifyMove", "tgNotifyProject", "tgNotifyRoleChanged", "tgNotifyTaskDeleted", "tgNotifyWorkspaceDeleted" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");
CREATE INDEX "User_email_idx" ON "User"("email");
CREATE INDEX "User_login_idx" ON "User"("login");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Customer_workspaceId_idx" ON "Customer"("workspaceId");

-- CreateIndex
CREATE INDEX "Customer_externalId_idx" ON "Customer"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_workspaceId_email_key" ON "Customer"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_status_updatedAt_idx" ON "Ticket"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_assigneeId_idx" ON "Ticket"("workspaceId", "assigneeId");

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_slaDeadline_idx" ON "Ticket"("workspaceId", "slaDeadline");

-- CreateIndex
CREATE INDEX "Ticket_customerId_idx" ON "Ticket"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_workspaceId_number_key" ON "Ticket"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");
