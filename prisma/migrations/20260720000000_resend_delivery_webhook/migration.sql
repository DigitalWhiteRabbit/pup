-- Delivery tracking (Resend webhooks)
ALTER TABLE "MktMessage" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "MktMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "MktMessage" ADD COLUMN "bouncedAt" TIMESTAMP(3);

-- Сырые события доставки Resend (дедуп повторов по svixId)
CREATE TABLE "MktEmailEvent" (
    "id" TEXT NOT NULL,
    "svixId" TEXT NOT NULL,
    "resendId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MktEmailEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MktEmailEvent_svixId_key" ON "MktEmailEvent"("svixId");
CREATE INDEX "MktEmailEvent_resendId_idx" ON "MktEmailEvent"("resendId");
