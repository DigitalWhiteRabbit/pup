-- CreateTable
CREATE TABLE "TicketCollaborator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'collaborator',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketCollaborator_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TicketCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TicketCollaborator_ticketId_idx" ON "TicketCollaborator"("ticketId");

-- CreateIndex
CREATE INDEX "TicketCollaborator_userId_idx" ON "TicketCollaborator"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketCollaborator_ticketId_userId_key" ON "TicketCollaborator"("ticketId", "userId");
