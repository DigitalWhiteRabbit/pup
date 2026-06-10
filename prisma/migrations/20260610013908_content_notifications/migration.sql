-- AlterTable: per-user toggle for Контент-план notifications
ALTER TABLE "User" ADD COLUMN "tgNotifyContent" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: link a notification to a content card
ALTER TABLE "Notification" ADD COLUMN "cardId" TEXT;

-- NotificationType gains CONTENT_REVIEW / CONTENT_CHANGES / CONTENT_APPROVED.
-- SQLite stores enums as TEXT, so no DDL is required for the new values.
