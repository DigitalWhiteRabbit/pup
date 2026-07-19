-- Пер-юзерный тумблер маркетинг-уведомлений
ALTER TABLE "User" ADD COLUMN "tgNotifyMarketing" BOOLEAN NOT NULL DEFAULT false;
-- Связь Telegram-сообщений консультации с записью (для reply-ответа из TG)
ALTER TABLE "MktConsultation" ADD COLUMN "tgMessageIds" TEXT;
