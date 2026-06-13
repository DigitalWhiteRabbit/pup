-- CreateTable
CREATE TABLE "MktTgAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT,
    "phone" TEXT,
    "apiId" INTEGER,
    "apiHash" TEXT,
    "session" TEXT,
    "proxyType" TEXT DEFAULT 'socks5',
    "proxyHost" TEXT,
    "proxyPort" INTEGER,
    "proxyUser" TEXT,
    "proxyPass" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "firstUsedAt" TEXT,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTodayDate" TEXT,
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "floodUntil" BIGINT,
    "lastSentAt" TEXT,
    "twoFa" TEXT,
    "userId" TEXT,
    "deviceModel" TEXT,
    "systemVersion" TEXT,
    "appVersion" TEXT,
    "langCode" TEXT,
    "systemLangCode" TEXT,
    "source" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MktTgAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MktTgAccount_workspaceId_idx" ON "MktTgAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "MktTgAccount_workspaceId_status_idx" ON "MktTgAccount"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "MktTgAccount" ADD CONSTRAINT "MktTgAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
