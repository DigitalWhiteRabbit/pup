-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "CustomerIdentityMethod" AS ENUM ('EMAIL_WITH_NAME', 'EMAIL_ONLY', 'ANONYMOUS', 'TELEGRAM_LOGIN');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ASSIGNED', 'COMMENTED', 'MOVED', 'PROJECT_ADDED', 'CONTENT_REVIEW', 'CONTENT_CHANGES', 'CONTENT_APPROVED');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('TASK_CREATED', 'TASK_DELETED', 'TASK_MOVED', 'TASK_UPDATED', 'TASK_ASSIGNEE_ADDED', 'TASK_ASSIGNEE_REMOVED', 'TASK_LABEL_ADDED', 'TASK_LABEL_REMOVED', 'TASK_PRIORITY_CHANGED', 'TASK_DATE_CHANGED', 'TASK_CHECKLIST_ITEM_ADDED', 'TASK_CHECKLIST_ITEM_TOGGLED', 'TASK_CHECKLIST_ITEM_REMOVED', 'COMMENT_CREATED', 'COMMENT_UPDATED', 'COMMENT_DELETED', 'ATTACHMENT_UPLOADED', 'ATTACHMENT_DELETED', 'COLUMN_CREATED', 'COLUMN_RENAMED', 'COLUMN_DELETED', 'COLUMN_REORDERED', 'WORKSPACE_CREATED', 'WORKSPACE_UPDATED', 'WORKSPACE_DELETED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_ROLE_CHANGED', 'MODULE_ENABLED', 'MODULE_DISABLED', 'KB_ARTICLE_CREATED', 'KB_ARTICLE_UPDATED', 'KB_ARTICLE_DELETED', 'KB_ARTICLE_VERSION_RESTORED', 'KB_CATEGORY_CREATED', 'KB_CATEGORY_UPDATED', 'KB_CATEGORY_DELETED', 'KB_TAG_CREATED', 'KB_TAG_DELETED', 'KB_ARTICLE_IMPORTED_FROM_FILE', 'KB_ARTICLE_IMPORTED_FROM_URL', 'KB_FILE_UPLOADED', 'KB_FILE_DELETED', 'KB_ARTICLE_REFRESHED_FROM_URL', 'KB_CRAWL_STARTED', 'KB_CRAWL_COMPLETED', 'KB_CRAWL_FAILED', 'KB_CRAWL_CANCELLED', 'KB_SEARCH_PERFORMED', 'TICKET_CREATED', 'TICKET_UPDATED', 'TICKET_STATUS_CHANGED', 'TICKET_ASSIGNED', 'TICKET_MESSAGE_ADDED', 'TICKET_SLA_BREACHED', 'TICKET_DELETED', 'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CHAT_SETTINGS_UPDATED', 'CHAT_PERSONA_CREATED', 'CHAT_PERSONA_UPDATED', 'CHAT_PERSONA_DELETED', 'CANNED_RESPONSE_CREATED', 'CANNED_RESPONSE_UPDATED', 'CANNED_RESPONSE_DELETED', 'TICKET_RATED', 'EMAIL_CONFIG_UPDATED', 'AGENT_CONFIG_UPDATED', 'AGENT_SCENARIO_CREATED', 'AGENT_SCENARIO_UPDATED', 'AGENT_SCENARIO_DELETED', 'AGENT_RESPONSE_GENERATED', 'CHAT_CHANNEL_CREATED', 'CHAT_MESSAGE_SENT', 'MKT_LEAD_CREATED', 'MKT_LEAD_UPDATED', 'MKT_LEAD_DELETED', 'MKT_LEAD_ENRICHED', 'MKT_LEAD_SCORED', 'MKT_PROJECT_CREATED', 'MKT_PROJECT_UPDATED', 'MKT_PROJECT_DELETED', 'MKT_CAMPAIGN_STARTED', 'MKT_CAMPAIGN_PAUSED', 'MKT_PARSER_STARTED', 'MKT_PARSER_COMPLETED', 'MKT_PARSER_FAILED', 'MKT_OUTREACH_SENT', 'MKT_OUTREACH_REPLIED', 'MKT_DEAL_CREATED', 'MKT_DEAL_APPROVED', 'MKT_DEAL_REJECTED', 'USER_LOGIN', 'USER_LOGOUT', 'USER_CREATED_BY_ADMIN', 'USER_DEACTIVATED', 'USER_ACTIVATED', 'USER_PASSWORD_RESET', 'USER_ROLE_CHANGED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "KbSourceType" AS ENUM ('MANUAL', 'FILE', 'URL');

-- CreateEnum
CREATE TYPE "KbCrawlStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('FINANCIAL', 'TECHNICAL', 'GENERAL', 'BUG', 'FEATURE_REQUEST');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('INTERNAL', 'EXTERNAL', 'EMAIL');

-- CreateEnum
CREATE TYPE "TicketMessageAuthorType" AS ENUM ('MANAGER', 'CUSTOMER', 'SYSTEM', 'AGENT');

-- CreateEnum
CREATE TYPE "ChatChannelType" AS ENUM ('GENERAL', 'PUBLIC', 'PRIVATE', 'DM');

-- CreateEnum
CREATE TYPE "MktLeadStatus" AS ENUM ('PENDING', 'READY', 'IN_WORK', 'DONE', 'REJECTED');

-- CreateEnum
CREATE TYPE "MktDialogueStage" AS ENUM ('NOT_CONTACTED', 'QUEUED', 'AWAITING_REVIEW', 'CONTACTED', 'AWAITING_REPLY', 'FOLLOWUP_1', 'FOLLOWUP_2', 'REPLIED', 'NEGOTIATING', 'DEAL_PENDING', 'WON', 'LOST', 'MOVED_TO_TG');

-- CreateEnum
CREATE TYPE "MktLeadSource" AS ENUM ('YOUTUBE', 'TELEGRAM', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "MktMsgDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MktMsgSender" AS ENUM ('AGENT', 'ADMIN', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "MktDealDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MktPendingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "MktKnowledgeStatus" AS ENUM ('PENDING', 'INDEXING', 'INDEXED', 'FAILED');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('IDEA', 'DRAFT', 'REVIEW', 'READY', 'PUBLISHED', 'PAUSED');

-- CreateEnum
CREATE TYPE "VisualStatus" AS ENUM ('NONE', 'IN_REVIEW', 'OK');

-- CreateEnum
CREATE TYPE "CardPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CardChannel" AS ENUM ('ALL', 'TELEGRAM', 'INSTAGRAM', 'X', 'TIKTOK', 'YOUTUBE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "CardFormat" AS ENUM ('POST', 'CAROUSEL', 'REELS', 'STORIES', 'VIDEO');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "avatarPath" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "telegramChatId" TEXT,
    "tgNotifyAssign" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyComment" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyMove" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyProject" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyContent" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTaskDeleted" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyMemberRemoved" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyWorkspaceDeleted" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyRoleChanged" BOOLEAN NOT NULL DEFAULT false,
    "tgNotifyTicketAssigned" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTicketMessage" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyTicketSlaBreached" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyDeploy" BOOLEAN NOT NULL DEFAULT true,
    "tgNotifyChat" BOOLEAN NOT NULL DEFAULT true,
    "chatSoundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "chatDesktopNotify" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logoPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT NOT NULL,
    "chatTitle" TEXT,
    "chatSubtitle" TEXT,
    "chatAccentColor" TEXT,
    "chatLogoUrl" TEXT,
    "chatIdentityMethod" "CustomerIdentityMethod" NOT NULL DEFAULT 'EMAIL_WITH_NAME',
    "chatPersonaRotation" BOOLEAN NOT NULL DEFAULT true,
    "chatAllowedEmbedOrigins" TEXT,
    "chatTimezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "externalAnalyticsUrl" TEXT,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "allowedIPs" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalUsersConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "apiEndpoint" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'bearer',
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalUsersConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceRoom" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "allowedUserIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceParticipant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT,
    "guestName" TEXT,
    "guestToken" TEXT,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "isScreenSharing" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSignal" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "VoiceSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceMessage" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT,
    "guestName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "participants" TEXT NOT NULL,
    "summary" TEXT,

    CONSTRAINT "VoiceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allowedModules" TEXT,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "minutesActive" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "heartbeats" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceModule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Column" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Column_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NONE',
    "position" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskLabel" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,

    CONSTRAINT "TaskLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeInterval" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TimeInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColumnMoveLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "movedByUserId" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromColumnName" TEXT NOT NULL,
    "toColumnName" TEXT NOT NULL,

    CONSTRAINT "ColumnMoveLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "NotificationType" NOT NULL,
    "taskId" TEXT,
    "cardId" TEXT,
    "workspaceId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorId" TEXT,
    "action" "ActivityAction" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "taskId" TEXT,
    "columnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeployMessage" (
    "id" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeployMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbCategory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,

    CONSTRAINT "KbTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbArticle" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "categoryId" TEXT,
    "sourceType" "KbSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "sourceFileId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "searchText" TEXT,
    "searchTextUpdatedAt" TIMESTAMP(3),
    "embedding" TEXT,
    "embeddingModel" TEXT,
    "embeddingUpdatedAt" TIMESTAMP(3),
    "authorId" TEXT,
    "lastEditedById" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbArticleTag" (
    "articleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "KbArticleTag_pkey" PRIMARY KEY ("articleId","tagId")
);

-- CreateTable
CREATE TABLE "KbArticleVersion" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "KbArticleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractedAt" TIMESTAMP(3),
    "extractionError" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbCrawl" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL DEFAULT 500,
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "timeoutMs" INTEGER NOT NULL DEFAULT 900000,
    "status" "KbCrawlStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pagesFound" INTEGER NOT NULL DEFAULT 0,
    "pagesCompleted" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "currentDepth" INTEGER NOT NULL DEFAULT 0,
    "articlesCreated" INTEGER NOT NULL DEFAULT 0,
    "articlesUpdated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "initiatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbCrawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbCrawlPage" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "error" TEXT,
    "articleId" TEXT,

    CONSTRAINT "KbCrawlPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbSearchHistory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "searchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbSearchHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "externalId" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" "TicketSource" NOT NULL,
    "category" "TicketCategory" NOT NULL DEFAULT 'GENERAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "slaDeadline" TIMESTAMP(3),
    "slaBreached" BOOLEAN NOT NULL DEFAULT false,
    "internalCreatorId" TEXT,
    "customerId" TEXT,
    "assigneeId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "needsHumanHelp" BOOLEAN NOT NULL DEFAULT false,
    "helpRequestedAt" TIMESTAMP(3),
    "agentConfidence" DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCollaborator" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'collaborator',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" "TicketMessageAuthorType" NOT NULL,
    "managerAuthorId" TEXT,
    "customerAuthorId" TEXT,
    "content" TEXT NOT NULL,
    "systemAction" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedByCustomerId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "ChatChannelType" NOT NULL DEFAULT 'PUBLIC',
    "name" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatChannelMember" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "typingAt" TIMESTAMP(3),

    CONSTRAINT "ChatChannelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMsg" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "linkedTicketId" TEXT,
    "linkedTaskId" TEXT,
    "forwardedFromId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "pinnedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMsg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMsgReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "ChatMsgReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMsgAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMsgAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMsgBookmark" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMsgBookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalChatMsg" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalChatMsg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalChatAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalChatAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalChatReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "GlobalChatReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'copilot',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "systemPrompt" TEXT,
    "greeting" TEXT,
    "guardrails" TEXT,
    "handoffThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "autoResolve" BOOLEAN NOT NULL DEFAULT false,
    "autoFaq" BOOLEAN NOT NULL DEFAULT false,
    "autoContactNotes" BOOLEAN NOT NULL DEFAULT false,
    "useKnowledgeBase" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentScenario" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceEmailConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUser" TEXT,
    "smtpPass" TEXT,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "inboundSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceEmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CannedResponse" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketRating" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPersona" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "position" INTEGER NOT NULL,
    "scheduleDays" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPersona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberClickLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "details" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberClickLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "source" TEXT NOT NULL,
    "method" TEXT,
    "path" TEXT,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "message" TEXT NOT NULL,
    "errorStack" TEXT,
    "metadata" TEXT,
    "workspaceId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "youtubeApiKey" TEXT,
    "anthropicApiKey" TEXT,
    "apifyToken" TEXT,
    "resendApiKey" TEXT,
    "resendSenderEmail" TEXT,
    "resendSenderName" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapUser" TEXT,
    "imapPass" TEXT,
    "tgApiId" TEXT,
    "tgApiHash" TEXT,
    "tgPhone" TEXT,
    "tgSession" TEXT,
    "adminBotToken" TEXT,
    "adminTgChatId" TEXT,
    "claudeModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "claudeModelSummary" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    "claudeModelComplex" TEXT NOT NULL DEFAULT 'claude-opus-4-20250115',
    "dailyCapEmail" INTEGER NOT NULL DEFAULT 200,
    "dailyCapTg" INTEGER NOT NULL DEFAULT 50,
    "maxRepliesPerTick" INTEGER NOT NULL DEFAULT 3,
    "loopMessageLimit" INTEGER NOT NULL DEFAULT 20,
    "dailyBudgetApify" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "monthlyBudgetApify" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "dailyBudgetClaude" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "monthlyBudgetClaude" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "budgetAlertPercent" INTEGER NOT NULL DEFAULT 80,
    "scoreModelId" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    "scoreThresholdHigh" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "scoreThresholdMedium" DOUBLE PRECISION NOT NULL DEFAULT 0.40,
    "scoreMinSubscribers" INTEGER NOT NULL DEFAULT 5000,
    "scorePrompt" TEXT,
    "dedupByEmail" BOOLEAN NOT NULL DEFAULT true,
    "dedupByUsername" BOOLEAN NOT NULL DEFAULT true,
    "dedupByNameGeo" BOOLEAN NOT NULL DEFAULT false,
    "reviewMode" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "followupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "followupDelayDays" INTEGER NOT NULL DEFAULT 3,
    "followupMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "warmupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "warmupStartDate" TIMESTAMP(3),
    "warmupSchedule" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "uniqueSellingPoints" TEXT,
    "targetAudience" TEXT,
    "budgetMin" INTEGER,
    "budgetMax" INTEGER,
    "adFormats" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "agentPersona" TEXT,
    "idealChannelProfile" TEXT,
    "badFitExamples" TEXT,
    "proofPoints" TEXT,
    "valueProp" TEXT,
    "signature" TEXT,
    "ctaText" TEXT,
    "ctaLink" TEXT,
    "creatorEconomics" TEXT,
    "toneOfVoice" TEXT,
    "stopWords" TEXT,
    "systemPrompt" TEXT,
    "adminDirective" TEXT,
    "pitchTemperature" DOUBLE PRECISION,
    "replyDelayMin" INTEGER,
    "replyDelayMax" INTEGER,
    "subjectPool" TEXT,
    "samplePitches" TEXT,
    "contentRedFlags" TEXT,
    "valuePropShort" TEXT,
    "abTestEnabled" BOOLEAN NOT NULL DEFAULT false,
    "abVariants" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelName" TEXT,
    "channelUrl" TEXT,
    "thumbnail" TEXT,
    "source" "MktLeadSource" NOT NULL DEFAULT 'YOUTUBE',
    "country" TEXT,
    "subscribers" INTEGER,
    "avgViews" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "erNormalized" DOUBLE PRECISION,
    "erFlags" TEXT,
    "email" TEXT,
    "telegram" TEXT,
    "instagram" TEXT,
    "twitter" TEXT,
    "tiktok" TEXT,
    "vk" TEXT,
    "discord" TEXT,
    "whatsapp" TEXT,
    "website" TEXT,
    "rawContacts" TEXT,
    "leadStatus" "MktLeadStatus" NOT NULL DEFAULT 'PENDING',
    "dialogueStage" "MktDialogueStage" NOT NULL DEFAULT 'NOT_CONTACTED',
    "leadScore" DOUBLE PRECISION,
    "scoreBreakdown" TEXT,
    "contentSummary" TEXT,
    "isDeepSummary" BOOLEAN NOT NULL DEFAULT false,
    "channelAboutText" TEXT,
    "channelTags" TEXT,
    "channelLanguage" TEXT,
    "mainCategory" TEXT,
    "channelAgeDays" INTEGER,
    "lastVideoDate" TIMESTAMP(3),
    "lastVideosJson" TEXT,
    "topPlaylistsJson" TEXT,
    "postingFrequency" DOUBLE PRECISION,
    "shortsCount" INTEGER,
    "shortsRatio" DOUBLE PRECISION,
    "shortsAvgViews" INTEGER,
    "longAvgViews" INTEGER,
    "projectId" TEXT,
    "agreedPrice" INTEGER,
    "notes" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "keyword" TEXT,
    "tgDraft" TEXT,
    "tgDraftRu" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "followupAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastFollowupAt" TIMESTAMP(3),
    "enrichedAt" TIMESTAMP(3),
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktLeadEmail" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "MktLeadEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktLeadAnalysis" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "metrics" TEXT,
    "reasoning" TEXT,
    "recommendation" TEXT,
    "score" INTEGER,
    "verdict" TEXT,
    "analyzedAt" TIMESTAMP(3),

    CONSTRAINT "MktLeadAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktDialogue" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalThreadId" TEXT,
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktDialogue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktMessage" (
    "id" TEXT NOT NULL,
    "dialogueId" TEXT NOT NULL,
    "direction" "MktMsgDirection" NOT NULL,
    "sender" "MktMsgSender" NOT NULL,
    "content" TEXT NOT NULL,
    "contentRu" TEXT,
    "subject" TEXT,
    "metadata" TEXT,
    "resendId" TEXT,
    "trackingId" TEXT,
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "abVariantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktDeal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "proposedPrice" INTEGER,
    "agentSummary" TEXT,
    "adminDecision" "MktDealDecision" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "MktDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktConsultation" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "question" TEXT NOT NULL,
    "context" TEXT,
    "adminResponse" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "MktConsultation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktPendingReply" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dialogueId" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "context" TEXT,
    "status" "MktPendingStatus" NOT NULL DEFAULT 'PENDING',
    "editedBody" TEXT,
    "editedSubject" TEXT,
    "adminNotes" TEXT,
    "abVariantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sendAfter" TIMESTAMP(3),

    CONSTRAINT "MktPendingReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktSearchTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "MktLeadSource" NOT NULL,
    "keywords" TEXT,
    "hashtags" TEXT,
    "country" TEXT,
    "language" TEXT,
    "category" TEXT,
    "minSubs" INTEGER,
    "maxSubs" INTEGER,
    "minEngagement" DOUBLE PRECISION,
    "sortBy" TEXT,
    "maxResults" INTEGER NOT NULL DEFAULT 100,
    "cronExpression" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunFound" INTEGER,
    "lastRunNew" INTEGER,
    "lastRunCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktSearchTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktSearchRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "source" "MktLeadSource" NOT NULL,
    "found" INTEGER NOT NULL DEFAULT 0,
    "newLeads" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "params" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MktSearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktSegment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" TEXT NOT NULL,
    "leadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktKnowledgeDoc" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT,
    "mime" TEXT,
    "sizeBytes" INTEGER,
    "content" TEXT NOT NULL,
    "checksum" TEXT,
    "chunksCount" INTEGER NOT NULL DEFAULT 0,
    "status" "MktKnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktKnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktKnowledgeChunk" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" TEXT,
    "tokenCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MktKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktDailyCounter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "emailsSent" INTEGER NOT NULL DEFAULT 0,
    "tgSent" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "tokensCacheRead" INTEGER NOT NULL DEFAULT 0,
    "tokensCacheCreate" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "MktDailyCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MktSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "MktSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCard" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "channel" "CardChannel" NOT NULL,
    "format" "CardFormat" NOT NULL,
    "priority" "CardPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "CardStatus" NOT NULL DEFAULT 'DRAFT',
    "visualStatus" "VisualStatus" NOT NULL DEFAULT 'NONE',
    "publishDate" TIMESTAMP(3),
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentMedia" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCardHistory" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentCardHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE INDEX "User_lastSeenAt_idx" ON "User"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_tokenHash_key" ON "ServiceAccount"("tokenHash");

-- CreateIndex
CREATE INDEX "ServiceAccount_workspaceId_idx" ON "ServiceAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalUsersConfig_workspaceId_key" ON "ExternalUsersConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "VoiceRoom_workspaceId_idx" ON "VoiceRoom"("workspaceId");

-- CreateIndex
CREATE INDEX "VoiceParticipant_roomId_idx" ON "VoiceParticipant"("roomId");

-- CreateIndex
CREATE INDEX "VoiceParticipant_userId_idx" ON "VoiceParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceParticipant_roomId_userId_key" ON "VoiceParticipant"("roomId", "userId");

-- CreateIndex
CREATE INDEX "VoiceSignal_roomId_toUserId_consumedAt_idx" ON "VoiceSignal"("roomId", "toUserId", "consumedAt");

-- CreateIndex
CREATE INDEX "VoiceMessage_roomId_createdAt_idx" ON "VoiceMessage"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceSession_workspaceId_startedAt_idx" ON "VoiceSession"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "MemberActivity_workspaceId_date_idx" ON "MemberActivity"("workspaceId", "date");

-- CreateIndex
CREATE INDEX "MemberActivity_userId_date_idx" ON "MemberActivity"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MemberActivity_userId_workspaceId_date_key" ON "MemberActivity"("userId", "workspaceId", "date");

-- CreateIndex
CREATE INDEX "WorkspaceModule_workspaceId_idx" ON "WorkspaceModule"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceModule_workspaceId_moduleKey_key" ON "WorkspaceModule"("workspaceId", "moduleKey");

-- CreateIndex
CREATE INDEX "Column_workspaceId_position_idx" ON "Column"("workspaceId", "position");

-- CreateIndex
CREATE INDEX "Column_workspaceId_idx" ON "Column"("workspaceId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_idx" ON "Task"("workspaceId");

-- CreateIndex
CREATE INDEX "Task_columnId_idx" ON "Task"("columnId");

-- CreateIndex
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");

-- CreateIndex
CREATE INDEX "TaskAssignee_taskId_idx" ON "TaskAssignee"("taskId");

-- CreateIndex
CREATE INDEX "TaskAssignee_userId_idx" ON "TaskAssignee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAssignee_taskId_userId_key" ON "TaskAssignee"("taskId", "userId");

-- CreateIndex
CREATE INDEX "Label_workspaceId_idx" ON "Label"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_workspaceId_name_key" ON "Label"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TaskLabel_taskId_idx" ON "TaskLabel"("taskId");

-- CreateIndex
CREATE INDEX "TaskLabel_labelId_idx" ON "TaskLabel"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskLabel_taskId_labelId_key" ON "TaskLabel"("taskId", "labelId");

-- CreateIndex
CREATE INDEX "ChecklistItem_taskId_position_idx" ON "ChecklistItem"("taskId", "position");

-- CreateIndex
CREATE INDEX "TimeInterval_taskId_endedAt_idx" ON "TimeInterval"("taskId", "endedAt");

-- CreateIndex
CREATE INDEX "ColumnMoveLog_taskId_idx" ON "ColumnMoveLog"("taskId");

-- CreateIndex
CREATE INDEX "ColumnMoveLog_movedByUserId_idx" ON "ColumnMoveLog"("movedByUserId");

-- CreateIndex
CREATE INDEX "Comment_taskId_idx" ON "Comment"("taskId");

-- CreateIndex
CREATE INDEX "Comment_authorId_idx" ON "Comment"("authorId");

-- CreateIndex
CREATE INDEX "Attachment_taskId_idx" ON "Attachment"("taskId");

-- CreateIndex
CREATE INDEX "Attachment_uploadedById_idx" ON "Attachment"("uploadedById");

-- CreateIndex
CREATE INDEX "Notification_recipientId_isRead_idx" ON "Notification"("recipientId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLinkToken_token_key" ON "TelegramLinkToken"("token");

-- CreateIndex
CREATE INDEX "ActivityLog_workspaceId_createdAt_idx" ON "ActivityLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_actorId_idx" ON "ActivityLog"("actorId");

-- CreateIndex
CREATE INDEX "ActivityLog_action_idx" ON "ActivityLog"("action");

-- CreateIndex
CREATE INDEX "ActivityLog_taskId_idx" ON "ActivityLog"("taskId");

-- CreateIndex
CREATE INDEX "ActivityLog_columnId_idx" ON "ActivityLog"("columnId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "DeployMessage_status_idx" ON "DeployMessage"("status");

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
CREATE INDEX "KbArticle_sourceFileId_idx" ON "KbArticle"("sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "KbArticle_workspaceId_slug_key" ON "KbArticle"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "KbArticleTag_tagId_idx" ON "KbArticleTag"("tagId");

-- CreateIndex
CREATE INDEX "KbArticleVersion_articleId_editedAt_idx" ON "KbArticleVersion"("articleId", "editedAt");

-- CreateIndex
CREATE INDEX "KbFile_workspaceId_uploadedAt_idx" ON "KbFile"("workspaceId", "uploadedAt");

-- CreateIndex
CREATE INDEX "KbFile_uploadedById_idx" ON "KbFile"("uploadedById");

-- CreateIndex
CREATE INDEX "KbCrawl_workspaceId_status_idx" ON "KbCrawl"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "KbCrawl_initiatedById_idx" ON "KbCrawl"("initiatedById");

-- CreateIndex
CREATE INDEX "KbCrawlPage_crawlId_status_idx" ON "KbCrawlPage"("crawlId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KbCrawlPage_crawlId_url_key" ON "KbCrawlPage"("crawlId", "url");

-- CreateIndex
CREATE INDEX "KbSearchHistory_userId_searchedAt_idx" ON "KbSearchHistory"("userId", "searchedAt");

-- CreateIndex
CREATE INDEX "KbSearchHistory_workspaceId_searchedAt_idx" ON "KbSearchHistory"("workspaceId", "searchedAt");

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
CREATE INDEX "TicketCollaborator_ticketId_idx" ON "TicketCollaborator"("ticketId");

-- CreateIndex
CREATE INDEX "TicketCollaborator_userId_idx" ON "TicketCollaborator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketCollaborator_ticketId_userId_key" ON "TicketCollaborator"("ticketId", "userId");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");

-- CreateIndex
CREATE INDEX "ChatChannel_workspaceId_type_idx" ON "ChatChannel"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "ChatChannelMember_channelId_idx" ON "ChatChannelMember"("channelId");

-- CreateIndex
CREATE INDEX "ChatChannelMember_userId_idx" ON "ChatChannelMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatChannelMember_channelId_userId_key" ON "ChatChannelMember"("channelId", "userId");

-- CreateIndex
CREATE INDEX "ChatMsg_channelId_deletedAt_createdAt_idx" ON "ChatMsg"("channelId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMsg_channelId_createdAt_idx" ON "ChatMsg"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMsg_parentId_idx" ON "ChatMsg"("parentId");

-- CreateIndex
CREATE INDEX "ChatMsg_forwardedFromId_idx" ON "ChatMsg"("forwardedFromId");

-- CreateIndex
CREATE INDEX "ChatMsgReaction_messageId_idx" ON "ChatMsgReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMsgReaction_messageId_userId_emoji_key" ON "ChatMsgReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "ChatMsgAttachment_messageId_idx" ON "ChatMsgAttachment"("messageId");

-- CreateIndex
CREATE INDEX "ChatMsgBookmark_userId_idx" ON "ChatMsgBookmark"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMsgBookmark_messageId_userId_key" ON "ChatMsgBookmark"("messageId", "userId");

-- CreateIndex
CREATE INDEX "GlobalChatMsg_createdAt_idx" ON "GlobalChatMsg"("createdAt");

-- CreateIndex
CREATE INDEX "GlobalChatMsg_parentId_idx" ON "GlobalChatMsg"("parentId");

-- CreateIndex
CREATE INDEX "GlobalChatAttachment_messageId_idx" ON "GlobalChatAttachment"("messageId");

-- CreateIndex
CREATE INDEX "GlobalChatReaction_messageId_idx" ON "GlobalChatReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalChatReaction_messageId_userId_emoji_key" ON "GlobalChatReaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfig_workspaceId_key" ON "AgentConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentScenario_agentId_position_idx" ON "AgentScenario"("agentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEmailConfig_workspaceId_key" ON "WorkspaceEmailConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "CannedResponse_workspaceId_idx" ON "CannedResponse"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CannedResponse_workspaceId_shortCode_key" ON "CannedResponse"("workspaceId", "shortCode");

-- CreateIndex
CREATE UNIQUE INDEX "TicketRating_ticketId_key" ON "TicketRating"("ticketId");

-- CreateIndex
CREATE INDEX "TicketRating_customerId_idx" ON "TicketRating"("customerId");

-- CreateIndex
CREATE INDEX "ChatPersona_workspaceId_position_idx" ON "ChatPersona"("workspaceId", "position");

-- CreateIndex
CREATE INDEX "MemberClickLog_userId_occurredAt_idx" ON "MemberClickLog"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "MemberClickLog_workspaceId_occurredAt_idx" ON "MemberClickLog"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "MemberClickLog_workspaceId_userId_occurredAt_idx" ON "MemberClickLog"("workspaceId", "userId", "occurredAt");

-- CreateIndex
CREATE INDEX "SystemLog_level_createdAt_idx" ON "SystemLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_source_idx" ON "SystemLog"("source");

-- CreateIndex
CREATE INDEX "SystemLog_workspaceId_idx" ON "SystemLog"("workspaceId");

-- CreateIndex
CREATE INDEX "SystemLog_userId_idx" ON "SystemLog"("userId");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MktConfig_workspaceId_key" ON "MktConfig"("workspaceId");

-- CreateIndex
CREATE INDEX "MktProject_workspaceId_isActive_idx" ON "MktProject"("workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "MktLead_workspaceId_leadStatus_dialogueStage_idx" ON "MktLead"("workspaceId", "leadStatus", "dialogueStage");

-- CreateIndex
CREATE INDEX "MktLead_workspaceId_source_idx" ON "MktLead"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "MktLead_workspaceId_leadScore_idx" ON "MktLead"("workspaceId", "leadScore");

-- CreateIndex
CREATE INDEX "MktLead_projectId_idx" ON "MktLead"("projectId");

-- CreateIndex
CREATE INDEX "MktLead_email_idx" ON "MktLead"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MktLead_workspaceId_channelId_key" ON "MktLead"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "MktLeadEmail_email_idx" ON "MktLeadEmail"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MktLeadEmail_leadId_email_key" ON "MktLeadEmail"("leadId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "MktLeadAnalysis_leadId_key" ON "MktLeadAnalysis"("leadId");

-- CreateIndex
CREATE INDEX "MktDialogue_leadId_idx" ON "MktDialogue"("leadId");

-- CreateIndex
CREATE INDEX "MktMessage_dialogueId_createdAt_idx" ON "MktMessage"("dialogueId", "createdAt");

-- CreateIndex
CREATE INDEX "MktMessage_resendId_idx" ON "MktMessage"("resendId");

-- CreateIndex
CREATE INDEX "MktMessage_trackingId_idx" ON "MktMessage"("trackingId");

-- CreateIndex
CREATE INDEX "MktDeal_leadId_idx" ON "MktDeal"("leadId");

-- CreateIndex
CREATE INDEX "MktDeal_projectId_idx" ON "MktDeal"("projectId");

-- CreateIndex
CREATE INDEX "MktDeal_adminDecision_idx" ON "MktDeal"("adminDecision");

-- CreateIndex
CREATE INDEX "MktConsultation_status_idx" ON "MktConsultation"("status");

-- CreateIndex
CREATE INDEX "MktPendingReply_status_idx" ON "MktPendingReply"("status");

-- CreateIndex
CREATE INDEX "MktPendingReply_leadId_idx" ON "MktPendingReply"("leadId");

-- CreateIndex
CREATE INDEX "MktSearchTask_workspaceId_idx" ON "MktSearchTask"("workspaceId");

-- CreateIndex
CREATE INDEX "MktSearchRun_taskId_startedAt_idx" ON "MktSearchRun"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "MktSegment_workspaceId_idx" ON "MktSegment"("workspaceId");

-- CreateIndex
CREATE INDEX "MktTemplate_workspaceId_idx" ON "MktTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "MktKnowledgeDoc_workspaceId_status_idx" ON "MktKnowledgeDoc"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MktKnowledgeChunk_docId_position_idx" ON "MktKnowledgeChunk"("docId", "position");

-- CreateIndex
CREATE INDEX "MktDailyCounter_workspaceId_dateKey_idx" ON "MktDailyCounter"("workspaceId", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "MktDailyCounter_workspaceId_dateKey_key" ON "MktDailyCounter"("workspaceId", "dateKey");

-- CreateIndex
CREATE INDEX "MktSetting_workspaceId_idx" ON "MktSetting"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "MktSetting_workspaceId_key_key" ON "MktSetting"("workspaceId", "key");

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

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccount" ADD CONSTRAINT "ServiceAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalUsersConfig" ADD CONSTRAINT "ExternalUsersConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceRoom" ADD CONSTRAINT "VoiceRoom_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceParticipant" ADD CONSTRAINT "VoiceParticipant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "VoiceRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceParticipant" ADD CONSTRAINT "VoiceParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSignal" ADD CONSTRAINT "VoiceSignal_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "VoiceRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceMessage" ADD CONSTRAINT "VoiceMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "VoiceRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceMessage" ADD CONSTRAINT "VoiceMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSession" ADD CONSTRAINT "VoiceSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "VoiceRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberActivity" ADD CONSTRAINT "MemberActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberActivity" ADD CONSTRAINT "MemberActivity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceModule" ADD CONSTRAINT "WorkspaceModule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Column" ADD CONSTRAINT "Column_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "Column"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLabel" ADD CONSTRAINT "TaskLabel_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLabel" ADD CONSTRAINT "TaskLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeInterval" ADD CONSTRAINT "TimeInterval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColumnMoveLog" ADD CONSTRAINT "ColumnMoveLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColumnMoveLog" ADD CONSTRAINT "ColumnMoveLog_movedByUserId_fkey" FOREIGN KEY ("movedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ContentCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbCategory" ADD CONSTRAINT "KbCategory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbTag" ADD CONSTRAINT "KbTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "KbFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KbCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticleTag" ADD CONSTRAINT "KbArticleTag_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticleTag" ADD CONSTRAINT "KbArticleTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "KbTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticleVersion" ADD CONSTRAINT "KbArticleVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticleVersion" ADD CONSTRAINT "KbArticleVersion_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbFile" ADD CONSTRAINT "KbFile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbFile" ADD CONSTRAINT "KbFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbCrawl" ADD CONSTRAINT "KbCrawl_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbCrawl" ADD CONSTRAINT "KbCrawl_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbCrawlPage" ADD CONSTRAINT "KbCrawlPage_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "KbCrawl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_internalCreatorId_fkey" FOREIGN KEY ("internalCreatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCollaborator" ADD CONSTRAINT "TicketCollaborator_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCollaborator" ADD CONSTRAINT "TicketCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_managerAuthorId_fkey" FOREIGN KEY ("managerAuthorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_customerAuthorId_fkey" FOREIGN KEY ("customerAuthorId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploadedByCustomerId_fkey" FOREIGN KEY ("uploadedByCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatChannelMember" ADD CONSTRAINT "ChatChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatChannelMember" ADD CONSTRAINT "ChatChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsg" ADD CONSTRAINT "ChatMsg_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsg" ADD CONSTRAINT "ChatMsg_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsg" ADD CONSTRAINT "ChatMsg_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ChatMsg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsg" ADD CONSTRAINT "ChatMsg_forwardedFromId_fkey" FOREIGN KEY ("forwardedFromId") REFERENCES "ChatMsg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsgReaction" ADD CONSTRAINT "ChatMsgReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMsg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsgReaction" ADD CONSTRAINT "ChatMsgReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsgAttachment" ADD CONSTRAINT "ChatMsgAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMsg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsgBookmark" ADD CONSTRAINT "ChatMsgBookmark_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMsg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMsgBookmark" ADD CONSTRAINT "ChatMsgBookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalChatMsg" ADD CONSTRAINT "GlobalChatMsg_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalChatMsg" ADD CONSTRAINT "GlobalChatMsg_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GlobalChatMsg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalChatAttachment" ADD CONSTRAINT "GlobalChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GlobalChatMsg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlobalChatReaction" ADD CONSTRAINT "GlobalChatReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "GlobalChatMsg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentScenario" ADD CONSTRAINT "AgentScenario_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEmailConfig" ADD CONSTRAINT "WorkspaceEmailConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketRating" ADD CONSTRAINT "TicketRating_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketRating" ADD CONSTRAINT "TicketRating_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPersona" ADD CONSTRAINT "ChatPersona_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktConfig" ADD CONSTRAINT "MktConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktProject" ADD CONSTRAINT "MktProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktLead" ADD CONSTRAINT "MktLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktLead" ADD CONSTRAINT "MktLead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "MktProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktLeadEmail" ADD CONSTRAINT "MktLeadEmail_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktLeadAnalysis" ADD CONSTRAINT "MktLeadAnalysis_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktDialogue" ADD CONSTRAINT "MktDialogue_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktMessage" ADD CONSTRAINT "MktMessage_dialogueId_fkey" FOREIGN KEY ("dialogueId") REFERENCES "MktDialogue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktDeal" ADD CONSTRAINT "MktDeal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktDeal" ADD CONSTRAINT "MktDeal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "MktProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktConsultation" ADD CONSTRAINT "MktConsultation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPendingReply" ADD CONSTRAINT "MktPendingReply_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "MktLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktPendingReply" ADD CONSTRAINT "MktPendingReply_dialogueId_fkey" FOREIGN KEY ("dialogueId") REFERENCES "MktDialogue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktSearchTask" ADD CONSTRAINT "MktSearchTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktSearchRun" ADD CONSTRAINT "MktSearchRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "MktSearchTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktSegment" ADD CONSTRAINT "MktSegment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktTemplate" ADD CONSTRAINT "MktTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktKnowledgeDoc" ADD CONSTRAINT "MktKnowledgeDoc_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktKnowledgeChunk" ADD CONSTRAINT "MktKnowledgeChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "MktKnowledgeDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktDailyCounter" ADD CONSTRAINT "MktDailyCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MktSetting" ADD CONSTRAINT "MktSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCard" ADD CONSTRAINT "ContentCard_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCard" ADD CONSTRAINT "ContentCard_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCard" ADD CONSTRAINT "ContentCard_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentMedia" ADD CONSTRAINT "ContentMedia_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ContentCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCardHistory" ADD CONSTRAINT "ContentCardHistory_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "ContentCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentCardHistory" ADD CONSTRAINT "ContentCardHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
