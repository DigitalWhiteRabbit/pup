-- CreateTable
CREATE TABLE "ChatChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PUBLIC',
    "name" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatChannelMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMsg" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    "linkedTicketId" TEXT,
    "linkedTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMsg_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMsg_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMsg_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ChatMsg" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMsgReaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    CONSTRAINT "ChatMsgReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMsg" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMsgReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMsgAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMsgAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMsg" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "tgNotifyTicketSlaBreached" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyChat" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_User" ("createdAt", "email", "id", "isActive", "lastSeenAt", "login", "password", "role", "telegramChatId", "tgNotifyAssign", "tgNotifyComment", "tgNotifyMemberRemoved", "tgNotifyMove", "tgNotifyProject", "tgNotifyRoleChanged", "tgNotifyTaskDeleted", "tgNotifyTicketAssigned", "tgNotifyTicketMessage", "tgNotifyTicketSlaBreached", "tgNotifyWorkspaceDeleted") SELECT "createdAt", "email", "id", "isActive", "lastSeenAt", "login", "password", "role", "telegramChatId", "tgNotifyAssign", "tgNotifyComment", "tgNotifyMemberRemoved", "tgNotifyMove", "tgNotifyProject", "tgNotifyRoleChanged", "tgNotifyTaskDeleted", "tgNotifyTicketAssigned", "tgNotifyTicketMessage", "tgNotifyTicketSlaBreached", "tgNotifyWorkspaceDeleted" FROM "User";
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
CREATE INDEX "ChatChannel_workspaceId_type_idx" ON "ChatChannel"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "ChatChannelMember_channelId_idx" ON "ChatChannelMember"("channelId");

-- CreateIndex
CREATE INDEX "ChatChannelMember_userId_idx" ON "ChatChannelMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatChannelMember_channelId_userId_key" ON "ChatChannelMember"("channelId", "userId");

-- CreateIndex
CREATE INDEX "ChatMsg_channelId_createdAt_idx" ON "ChatMsg"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMsg_parentId_idx" ON "ChatMsg"("parentId");

-- CreateIndex
CREATE INDEX "ChatMsgReaction_messageId_idx" ON "ChatMsgReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMsgReaction_messageId_userId_emoji_key" ON "ChatMsgReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "ChatMsgAttachment_messageId_idx" ON "ChatMsgAttachment"("messageId");
