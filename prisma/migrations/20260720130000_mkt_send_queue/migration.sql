-- Очередь отправки одобренных писем.
-- sendingAt: момент claim approved→sending. По нему диспетчер реанимирует записи,
-- зависшие в SENDING после падения процесса (decidedAt для этого не годится —
-- он про время одобрения и у отложенного письма всегда «старый»).
ALTER TABLE "MktPendingReply" ADD COLUMN "sendingAt" TIMESTAMP(3);

-- Горячая выборка очереди: status + sendAfter, тик раз в 20 секунд.
CREATE INDEX "MktPendingReply_status_sendAfter_idx" ON "MktPendingReply"("status", "sendAfter");

-- Новое окно задержки одобренного письма: 1-10 минут вместо 30-90.
-- Трогаем только проекты, стоящие ровно на старом дефолте: осознанно
-- выставленные значения не перетираем.
-- NULL считаем «не настроено»: код для него и так подставляет новый дефолт.
UPDATE "MktProject"
SET "replyDelayMin" = 1, "replyDelayMax" = 10
WHERE ("replyDelayMin" = 30 OR "replyDelayMin" IS NULL)
  AND ("replyDelayMax" = 90 OR "replyDelayMax" IS NULL);
