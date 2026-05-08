-- AlterTable
ALTER TABLE "Task" ADD COLUMN "dueDate" DATETIME;
ALTER TABLE "Task" ADD COLUMN "startDate" DATETIME;

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    CONSTRAINT "Label_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    CONSTRAINT "TaskLabel_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Label_projectId_idx" ON "Label"("projectId");
CREATE UNIQUE INDEX "Label_projectId_name_key" ON "Label"("projectId", "name");
CREATE INDEX "TaskLabel_taskId_idx" ON "TaskLabel"("taskId");
CREATE INDEX "TaskLabel_labelId_idx" ON "TaskLabel"("labelId");
CREATE UNIQUE INDEX "TaskLabel_taskId_labelId_key" ON "TaskLabel"("taskId", "labelId");
CREATE INDEX "ChecklistItem_taskId_position_idx" ON "ChecklistItem"("taskId", "position");
