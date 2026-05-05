# Data Model: CRM Канбан-система

**Branch**: `001-crm-kanban-system` | **Date**: 2026-05-05

---

## Prisma Schema (source of truth)

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"   // prod: "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────
// ПОЛЬЗОВАТЕЛИ
// ─────────────────────────────────────────

model User {
  id          String   @id @default(cuid())
  login       String   @unique
  email       String   @unique
  password    String   // bcrypt hash
  role        Role     @default(USER)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())

  // Telegram
  telegramChatId  String?  @unique
  tgNotifyAssign  Boolean  @default(true)
  tgNotifyComment Boolean  @default(true)
  tgNotifyMove    Boolean  @default(true)
  tgNotifyProject Boolean  @default(true)

  // Relations
  ownedProjects    Project[]         @relation("ProjectOwner")
  memberships      ProjectMember[]
  tasks            Task[]            @relation("TaskAssignee")
  comments         Comment[]
  attachments      Attachment[]
  notifications    Notification[]
  movedTasks       ColumnMoveLog[]
  telegramTokens   TelegramLinkToken[]

  @@index([email])
  @@index([login])
}

enum Role {
  ADMIN
  USER
}

// ─────────────────────────────────────────
// ПРОЕКТЫ
// ─────────────────────────────────────────

model Project {
  id          String   @id @default(cuid())
  name        String
  description String?
  createdAt   DateTime @default(now())

  ownerId     String
  owner       User     @relation("ProjectOwner", fields: [ownerId], references: [id])

  members     ProjectMember[]
  columns     Column[]
  tasks       Task[]

  @@index([ownerId])
}

model ProjectMember {
  id        String      @id @default(cuid())
  projectId String
  userId    String
  role      MemberRole  @default(MEMBER)
  joinedAt  DateTime    @default(now())

  project   Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([projectId])
  @@index([userId])
}

enum MemberRole {
  OWNER
  MEMBER
}

// ─────────────────────────────────────────
// КОЛОНКИ
// ─────────────────────────────────────────

model Column {
  id        String   @id @default(cuid())
  projectId String
  name      String
  position  Int      // порядок на доске
  createdAt DateTime @default(now())

  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  tasks     Task[]

  @@index([projectId])
  @@unique([projectId, position])
}

// ─────────────────────────────────────────
// ЗАДАЧИ
// ─────────────────────────────────────────

model Task {
  id          String   @id @default(cuid())
  projectId   String
  columnId    String
  title       String
  description String?
  position    Int      // порядок внутри колонки
  assigneeId  String?
  createdAt   DateTime @default(now())

  project     Project         @relation(fields: [projectId], references: [id], onDelete: Cascade)
  column      Column          @relation(fields: [columnId], references: [id])
  assignee    User?           @relation("TaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)

  timeIntervals TimeInterval[]
  moveLogs      ColumnMoveLog[]
  comments      Comment[]
  attachments   Attachment[]
  notifications Notification[]

  @@index([projectId])
  @@index([columnId])
  @@index([assigneeId])
}

// ─────────────────────────────────────────
// УЧЁТ ВРЕМЕНИ
// ─────────────────────────────────────────

model TimeInterval {
  id        String    @id @default(cuid())
  taskId    String
  startedAt DateTime  @default(now())
  endedAt   DateTime? // null = интервал открыт (задача в работе)

  task      Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId, endedAt])  // для быстрого расчёта суммарного времени
}

// ─────────────────────────────────────────
// ИСТОРИЯ ПЕРЕМЕЩЕНИЙ
// ─────────────────────────────────────────

model ColumnMoveLog {
  id             String   @id @default(cuid())
  taskId         String
  movedByUserId  String
  movedAt        DateTime @default(now())
  fromColumnName String   // snapshot имени на момент перемещения
  toColumnName   String

  task           Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  movedBy        User     @relation(fields: [movedByUserId], references: [id])

  @@index([taskId])
}

// ─────────────────────────────────────────
// КОММЕНТАРИИ
// ─────────────────────────────────────────

model Comment {
  id        String   @id @default(cuid())
  taskId    String
  authorId  String
  text      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  author    User     @relation(fields: [authorId], references: [id])

  @@index([taskId])
}

// ─────────────────────────────────────────
// ВЛОЖЕНИЯ
// ─────────────────────────────────────────

model Attachment {
  id              String   @id @default(cuid())
  taskId          String
  uploadedById    String
  originalName    String
  size            Int      // bytes
  mimeType        String
  storagePath     String   // uploads/{projectId}/{taskId}/{uuid}-{originalName}
  uploadedAt      DateTime @default(now())

  task            Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  uploadedBy      User     @relation(fields: [uploadedById], references: [id])

  @@index([taskId])
}

// ─────────────────────────────────────────
// УВЕДОМЛЕНИЯ
// ─────────────────────────────────────────

model Notification {
  id          String           @id @default(cuid())
  recipientId String
  type        NotificationType
  taskId      String?
  projectId   String?
  isRead      Boolean          @default(false)
  createdAt   DateTime         @default(now())

  recipient   User             @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  task        Task?            @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@index([recipientId, isRead])
}

enum NotificationType {
  ASSIGNED        // назначен на задачу
  COMMENTED       // комментарий к твоей задаче
  MOVED           // твоя задача перемещена
  PROJECT_ADDED   // добавлен в проект
}

// ─────────────────────────────────────────
// TELEGRAM: одноразовые коды привязки
// ─────────────────────────────────────────

model TelegramLinkToken {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime // now + 10 min

  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([token])
}
```

---

## Ключевые бизнес-правила модели

### Порядок (position)

- `Column.position` и `Task.position` — целые числа, уникальные в рамках проекта/колонки.
- При drag&drop пересчитываются только затронутые записи (сдвиг на ±1), не весь список.
- При удалении — позиции оставшихся элементов пересчитываются (нет «дыр»).

### Колонка "В работе"

- Определяется через `column.name.trim().toLowerCase() === "в работе"`.
- При попадании задачи в такую колонку — `INSERT TimeInterval { startedAt: now, endedAt: null }`.
- При уходе — `UPDATE TimeInterval SET endedAt = now WHERE taskId = X AND endedAt IS NULL`.
- При переименовании колонки (триггер в `task.service`):
  - В "В работе" → INSERT TimeInterval для всех задач в колонке.
  - Из "В работе" → UPDATE TimeInterval SET endedAt для всех задач с открытыми интервалами.

### Суммарное время задачи

```
totalMs = SUM(
  COALESCE(endedAt, now()) - startedAt
) WHERE taskId = X
```

Вычисляется в `timer.service.calculateTotalTime(taskId)`.
Открытый интервал (`endedAt = null`) учитывается как `now()`.

### Удаление колонки

- Колонка с задачами (`tasks.length > 0`) **не может быть удалена**.
- Сервис возвращает ошибку `COLUMN_HAS_TASKS` — UI показывает toast с инструкцией.

### Пользователь и проект

- `Project.ownerId` указывает на создателя.
- `ProjectMember` хранит роль OWNER/MEMBER. При создании проекта — автоматически создаётся запись
  ProjectMember с role=OWNER для создателя (две записи: в Project и ProjectMember).
- ADMIN видит все проекты через `prisma.project.findMany()` без фильтра по userId.

### Каскадные удаления

- `Project` удаляется → каскадно удаляются Column, Task, Comment, Attachment, Notification,
  ProjectMember.
- `Task` удаляется → каскадно удаляются TimeInterval, ColumnMoveLog, Comment, Attachment.
- Физические файлы удаляются через `FileStorage.delete()` до или после транзакции
  (в зависимости от операции — см. contracts).

### Деактивированный пользователь

- `User.isActive = false` — не может войти (проверка в NextAuth `authorize`).
- Связанные данные (Task.assignee, Comment.author) сохраняются — `onDelete: SetNull` для assignee.
- В UI показывается `"(деактивирован)"` рядом с именем.

---

## Индексы (оптимизация запросов)

| Таблица | Индекс | Причина |
|---------|--------|---------|
| User | email, login | Поиск при логине |
| Task | projectId, columnId, assigneeId | Загрузка доски, фильтр по assignee |
| TimeInterval | taskId + endedAt | Расчёт суммарного времени |
| Notification | recipientId + isRead | Счётчик непрочитанных |
| ColumnMoveLog | taskId | История задачи |
| TelegramLinkToken | token | Поиск при привязке бота |
