# Tasks: CRM Канбан-система управления проектами и задачами

**Input**: Design documents from `specs/001-crm-kanban-system/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/api.md, research.md, quickstart.md

**Total tasks**: 78 (T001–T077 + T024a)

**Tests**: Unit-тесты включены для критичных сервисов (timer, notification, storage) — по решению из research.md.

**Organization**: Задачи сгруппированы по user stories для независимой реализации и тестирования.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Можно выполнять параллельно (разные файлы, нет зависимостей)
- **[Story]**: К какой user story относится (US1, US2, US3, US4, US5, US6)
- Пути файлов указаны от корня проекта

---

## Phase 1: Setup

**Purpose**: Инициализация проекта, установка зависимостей, базовая конфигурация

- [ ] T001 Initialize Next.js 14 project with App Router and TypeScript strict mode via `pnpm create next-app`
- [ ] T002 Configure TypeScript: `strict: true`, `noUncheckedIndexedAccess: true` in `tsconfig.json`
- [ ] T003 [P] Install and configure Tailwind CSS 3 in `tailwind.config.ts` and `app/globals.css`
- [ ] T004 [P] Initialize shadcn/ui: run `pnpm dlx shadcn-ui@latest init`, configure `components.json`
- [ ] T005 [P] Install core dependencies: `pnpm add prisma @prisma/client next-auth@5 zod @tanstack/react-query @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities react-hook-form @hookform/resolvers bcrypt date-fns server-only node-telegram-bot-api`
- [ ] T006 [P] Install dev dependencies: `pnpm add -D @types/bcrypt @types/node vitest husky lint-staged prettier eslint-config-next`
- [ ] T007 [P] Create `.env.example` with all env vars (DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, TELEGRAM_BOT_TOKEN, STORAGE_DRIVER, UPLOAD_DIR, INITIAL_ADMIN_LOGIN, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD)
- [ ] T008 [P] Configure `.gitignore`: add `uploads/`, `prisma/dev.db`, `.env`, `dev.db.bak`
- [ ] T009 [P] Add `package.json` scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `db:migrate`, `db:reset`, `db:seed`, `test`, `test:watch`
- [ ] T010 [P] Configure Husky + lint-staged: pre-commit runs `prettier --write` and `eslint --fix` on staged files
- [ ] T011 [P] Create `.npmrc` with `engine-strict=true` to enforce pnpm

**Checkpoint**: Проект инициализирован, `pnpm dev` запускается без ошибок

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Prisma schema, NextAuth, Prisma client, базовые утилиты — блокирует ВСЕ user stories

**⚠️ CRITICAL**: Работа над user stories невозможна до завершения этой фазы

- [ ] T012 Create Prisma schema with all 11 models (User, Project, ProjectMember, Column, Task, TimeInterval, ColumnMoveLog, Comment, Attachment, Notification, TelegramLinkToken) and enums (Role, MemberRole, NotificationType) in `prisma/schema.prisma` — copy from `data-model.md`
- [ ] T013 Run `pnpm db:migrate` to generate initial migration
- [ ] T014 Create Prisma client singleton with `server-only` import in `lib/db.ts`
- [ ] T015 [P] Create Zod schema files (one per entity) in `lib/schemas/`: `user.schema.ts`, `project.schema.ts`, `column.schema.ts`, `task.schema.ts`, `comment.schema.ts`, `attachment.schema.ts`, `notification.schema.ts`
- [ ] T016 [P] Configure NextAuth v5 in `lib/auth.ts`: Credentials provider (login/email + password), JWT strategy, `callbacks.session` checks `User.isActive` from DB — returns `null` if `false` (FR-004a)
- [ ] T017 [P] Create `app/api/auth/[...nextauth]/route.ts` — NextAuth route handler
- [ ] T018 Create seed script `prisma/seed.ts`: reads `INITIAL_ADMIN_*` from env, creates first ADMIN with bcrypt-hashed password. Support optional `SEED_DEMO_DATA=true` env flag — when enabled, additionally create 1 demo project owned by admin, with 3 default columns and 5 demo tasks distributed across columns. Used for local development convenience
- [ ] T019 [P] Create TanStack Query provider in `components/providers/query-provider.tsx` (Client Component)
- [ ] T020 [P] Create session provider wrapper in `components/providers/session-provider.tsx` (Client Component)
- [ ] T021 Create authenticated layout `app/(authenticated)/layout.tsx`: check session, redirect to `/login` if unauthenticated, wrap with providers
- [ ] T022 [P] Add shadcn/ui base components: `Button`, `Input`, `Dialog`, `DropdownMenu`, `Toast`, `Skeleton`, `Card`, `Badge`, `Label`, `Textarea`, `Avatar` via `pnpm dlx shadcn-ui@latest add`
- [ ] T023 [P] Create toast utility in `lib/toast.ts`: wrapper around shadcn Toaster for human-readable error messages (Constitution XVII)
- [ ] T024 [P] Create API error handler utility in `lib/api-error.ts`: standardized `{ error: string, code: string }` responses with try/catch wrapper for route handlers
- [ ] T024a [P] Create stub `notification.service.ts` in `lib/services/notification.service.ts` with no-op methods: `notify(type, recipientId, actorId, taskId?, projectId?)` returns void, `getNotifications(userId, opts)` returns empty array, `markAsRead(ids, userId)` returns void. Real implementation will replace stubs in T061. This unblocks US3 `task.service.moveTask()` integration

**Checkpoint**: База данных создана, NextAuth работает, `pnpm db:seed` создаёт первого ADMIN

---

## Phase 3: User Story 1 — Авторизация и управление учётными записями (Priority: P1) 🎯 MVP

**Goal**: ADMIN создаёт пользователей, пользователи логинятся, ADMIN деактивирует пользователей

**Independent Test**: CLI-сидер → ADMIN входит → создаёт USER → USER входит → ADMIN деактивирует → USER не может войти

### Implementation for User Story 1

- [ ] T025 [US1] Implement `auth.service.ts` in `lib/services/auth.service.ts`: `generatePassword()` (12 chars, crypto.randomBytes → base62), `hashPassword()`, `verifyPassword()`, `createUser()`, `deactivateUser()`, `activateUser()`, `resetPassword()`, `changeRole()`
- [ ] T026 [US1] Create login page `app/(auth)/login/page.tsx`: form with login/email + password fields (React Hook Form + Zod validation), redirect to `/projects` on success
- [ ] T027 [US1] Implement `POST /api/admin/users` route in `app/api/admin/users/route.ts`: validate ADMIN role, call `auth.service.createUser()`, return user + temporaryPassword; implement `GET /api/admin/users` with pagination
- [ ] T028 [US1] Implement `PATCH /api/admin/users/[id]/deactivate/route.ts`: validate ADMIN, call `auth.service.deactivateUser()`
- [ ] T029 [P] [US1] Implement `PATCH /api/admin/users/[id]/activate/route.ts`: validate ADMIN, call `auth.service.activateUser()`
- [ ] T030 [P] [US1] Implement `PATCH /api/admin/users/[id]/role/route.ts`: validate ADMIN, call `auth.service.changeRole()`
- [ ] T031 [P] [US1] Implement `POST /api/admin/users/[id]/reset-password/route.ts`: validate ADMIN, call `auth.service.resetPassword()`, return new temporaryPassword
- [ ] T032 [US1] Create admin users page `app/(authenticated)/admin/users/page.tsx`: table with users list (skeleton-UI while loading), create user dialog (shows generated password once), deactivate/activate/role change buttons; ADMIN-only access check

**Checkpoint**: ADMIN может создавать/деактивировать пользователей, USER может войти/выйти

---

## Phase 4: User Story 2 — Создание проектов и управление участниками (Priority: P1)

**Goal**: Пользователи создают проекты, добавляют участников, видят только свои проекты

**Independent Test**: USER создаёт проект → добавляет другого USER → второй видит проект → не-участник не видит

### Implementation for User Story 2

- [ ] T033 [US2] Implement `project.service.ts` in `lib/services/project.service.ts`: `createProject()` (+ 3 default columns + OWNER membership), `getProjectsForUser()` (with pagination, ADMIN sees all), `getProjectById()` (full board load with include), `updateProject()`, `deleteProject()` (cascade + file cleanup), `addMember()`, `removeMember()`, `checkMembership()`
- [ ] T034 [US2] Implement `GET/POST /api/projects` route in `app/api/projects/route.ts`: list with pagination (FR-008/009), create with auto-OWNER
- [ ] T035 [US2] Implement `GET/PATCH/DELETE /api/projects/[id]/route.ts`: full board load (one Prisma query with include — no N+1), update, delete
- [ ] T036 [P] [US2] Implement `POST /api/projects/[id]/members/route.ts`: add member by login or email; `DELETE /api/projects/[id]/members/[userId]/route.ts`: remove member (OWNER only, can't remove self). Notification triggers are integrated later in T064 (US6). For now `project.service.addMember()` does NOT call `notification.service`
- [ ] T037 [US2] Create projects list page `app/(authenticated)/projects/page.tsx`: project cards with skeleton-UI, "Create project" button + dialog (name, description)
- [ ] T038 [US2] Create project board page shell `app/(authenticated)/projects/[id]/page.tsx`: load project data via TanStack Query, show project name + members list, prepare layout for columns (implemented in US3)

**Checkpoint**: Проекты создаются с 3 колонками, участники добавляются/удаляются, доступ контролируется

---

## Phase 5: User Story 3 — Канбан-доска: колонки и задачи с drag&drop (Priority: P1)

**Goal**: Участники работают с доской: создают/перемещают задачи и колонки через drag&drop с оптимистичными обновлениями

**Independent Test**: Создать задачу → перетащить в другую колонку → UI обновился мгновенно → перетащить колонку → порядок изменился

### Implementation for User Story 3

- [ ] T039 [US3] Implement `task.service.ts` in `lib/services/task.service.ts`: `createTask()`, `updateTask()`, `deleteTask()`, `moveTask()` (atomic transaction: update columnId/position + ColumnMoveLog + TimeInterval open/close + Notification), `reorderTask()` (within column), `getTaskById()` (full card with comments, attachments, moveHistory). Notification dispatch in `moveTask` uses `notification.service` stub from T024a — real implementation in T061. ColumnMoveLog: insert directly in `moveTask` transaction (no separate service needed)
- [ ] T040 [P] [US3] Implement column service methods in `project.service.ts`: `createColumn()`, `renameColumn()` (with TimeInterval batch open/close for "В работе"), `deleteColumn()` (block if has tasks — COLUMN_HAS_TASKS error), `reorderColumn()`
- [ ] T041 [US3] Implement task API routes: `GET/POST /api/projects/[id]/tasks/route.ts`, `GET/PATCH/DELETE /api/tasks/[id]/route.ts`, `POST /api/tasks/[id]/move/route.ts`, `PATCH /api/tasks/[id]/position/route.ts`
- [ ] T042 [P] [US3] Implement column API routes: `GET/POST /api/projects/[id]/columns/route.ts`, `PATCH/DELETE /api/columns/[id]/route.ts`, `PATCH /api/columns/[id]/position/route.ts`
- [ ] T043 [US3] Create `Board` component in `components/board/Board.tsx`: DnDContext with DragOverlay, renders columns horizontally, handles column drag&drop reorder with optimistic update + rollback on error
- [ ] T044 [US3] Create `Column` component in `components/board/Column.tsx`: SortableContext for tasks, column header with rename (inline edit) + delete + add task button, renders TaskCard list
- [ ] T045 [US3] Create `TaskCard` component in `components/board/TaskCard.tsx`: draggable card showing title, assignee avatar, time badge (totalTimeMs formatted via date-fns); useSortable from @dnd-kit
- [ ] T046 [US3] Implement drag&drop logic in Board: `onDragEnd` handler — detect column vs task drag, call `moveTask` or `reorderColumn` mutation with optimistic update (`onMutate` snapshot → `onError` rollback → `onSettled` invalidate), show toast on error (Constitution XVI)
- [ ] T047 [US3] Create `TaskModal` component in `components/board/TaskModal.tsx`: Dialog showing full task details (title edit, description textarea, assignee select from project members, move history timeline); opened on TaskCard click

**Checkpoint**: Полностью рабочая канбан-доска с drag&drop, оптимистичными обновлениями и откатом

---

## Phase 6: User Story 4 — Учёт времени в работе (Priority: P2)

**Goal**: Автоматический таймер при нахождении задачи в колонке "В работе", живой счётчик на карточке

**Independent Test**: Перетащить задачу в "В работе" → виден живой счётчик → переместить обратно → таймер остановлен, время сохранено

### Implementation for User Story 4

- [ ] T048 [US4] Implement `timer.service.ts` in `lib/services/timer.service.ts`: `openInterval(taskId)`, `closeInterval(taskId)`, `closeAllIntervalsForColumn(columnId)`, `openAllIntervalsForColumn(columnId)`, `calculateTotalTime(taskId)` (SUM with COALESCE for open intervals), `isInProgress(taskId)`, `isWorkColumn(name)` (case-insensitive "в работе" check)
- [ ] T049 [US4] Integrate timer.service calls into `task.service.moveTask()` and `project.service.renameColumn()` — already scaffolded in US3, now add actual TimeInterval logic
- [ ] T050 [US4] Create live timer display in `TaskCard`: if `isInProgress`, show `useTimer` hook (client-side setInterval incrementing from server `totalTimeMs` + `Date.now() - lastIntervalStartedAt`); format via date-fns `formatDuration`
- [ ] T051 [US4] Add `totalTimeMs` and `isInProgress` to board API response in `GET /api/projects/[id]` — calculate in Prisma query or service layer
- [ ] T052 [US4] Unit tests for timer.service in `tests/unit/timer.service.test.ts`: test `calculateTotalTime` with multiple intervals, open interval, no intervals; test `isWorkColumn` case-insensitivity; test batch open/close for column rename scenarios

**Checkpoint**: Таймер работает автоматически, живой счётчик обновляется каждую секунду, суммарное время корректно

---

## Phase 7: User Story 5 — Комментарии и вложения к задачам (Priority: P2)

**Goal**: Обсуждение задач через комментарии, прикрепление файлов с проверкой доступа

**Independent Test**: Добавить комментарий → виден всем участникам → загрузить файл → скачать другим участником → не-участник получает 403

### Implementation for User Story 5

- [ ] T053 [US5] Implement `FileStorage` interface in `lib/services/storage/types.ts`: `upload(projectId, taskId, file): Promise<StorageResult>`, `download(storagePath): Promise<ReadableStream>`, `delete(storagePath): Promise<void>`, `getUrl(storagePath): string`
- [ ] T054 [US5] Implement `LocalStorage` in `lib/services/storage/local.storage.ts`: create dirs `uploads/{projectId}/{taskId}/`, save as `{uuid}-{originalName}`, return storagePath
- [ ] T055 [P] [US5] Create storage factory in `lib/services/storage/index.ts`: read `STORAGE_DRIVER` from env, return `LocalStorage` instance (Constitution IX)
- [ ] T056 [US5] Implement comment API routes: `POST /api/tasks/[id]/comments/route.ts` (any member), `PATCH/DELETE /api/comments/[id]/route.ts` (author only)
- [ ] T057 [US5] Implement attachment API routes: `POST /api/tasks/[id]/attachments/route.ts` (multipart upload via FileStorage), `GET /api/attachments/[id]/route.ts` (download with membership check — 403 if not member), `DELETE /api/attachments/[id]/route.ts` (uploader or OWNER)
- [ ] T058 [US5] Add comments list and add-comment form to `TaskModal` (`components/board/TaskModal.tsx`): show author, date, text; edit/delete buttons only for own comments
- [ ] T059 [US5] Add attachments section to `TaskModal`: file upload dropzone, list of attachments with download link and delete button (visible for uploader/OWNER)
- [ ] T060 [US5] Unit tests for LocalStorage in `tests/unit/local.storage.test.ts`: test upload creates file at correct path, download returns stream, delete removes file, handles missing file gracefully

**Checkpoint**: Комментарии и файлы работают, доступ к файлам защищён проверкой членства

---

## Phase 8: User Story 6 — Уведомления in-app и Telegram (Priority: P2)

**Goal**: Колокольчик с непрочитанными + Telegram-интеграция через бота

**Independent Test**: Назначить USER на задачу → в колокольчике +1 → подключить Telegram через код → получить уведомление в Telegram

### Implementation for User Story 6

- [ ] T061 [US6] Implement `notification.service.ts` in `lib/services/notification.service.ts`: `notify(type, recipientId, actorId, taskId?, projectId?)` — creates in-app notification (skips if actor === recipient, FR-029), then dispatches to Telegram transport asynchronously; `getNotifications(userId, unreadOnly?, page)`, `markAsRead(ids?, userId)`
- [ ] T062 [US6] Implement Telegram sender in `lib/services/telegram/sender.ts`: `sendTelegramNotification(chatId, message)` with retry (3 attempts, backoff 1s/5s/30s), `console.error` on final failure; message templates for each notification type
- [ ] T063 [P] [US6] Implement Telegram bot in `lib/services/telegram/bot.ts`: initialize `node-telegram-bot-api` in long-polling mode, handle `/start <code>` command — look up `TelegramLinkToken`, validate TTL, link `chatId` to User, delete token
- [ ] T064 [US6] Integrate notification triggers into existing services: `task.service.moveTask()` → MOVED, `task.service.createTask()`/`updateTask()` (assignee change) → ASSIGNED, comment creation → COMMENTED, `project.service.addMember()` → PROJECT_ADDED
- [ ] T065 [US6] Implement notification API routes: `GET /api/notifications/route.ts` (paginated, unreadOnly filter), `POST /api/notifications/read/route.ts` (mark ids or all as read)
- [ ] T066 [P] [US6] Implement Telegram profile API routes: `POST /api/profile/telegram/generate-code/route.ts` (create TelegramLinkToken with 10min TTL), `POST /api/profile/telegram/disconnect/route.ts` (set chatId=null)
- [ ] T067 [US6] Create notification bell component in `components/notifications/NotificationBell.tsx`: icon in header with unread count badge, dropdown list of notifications with "mark all read" button and links to related tasks; TanStack Query polling for count
- [ ] T068 [US6] Create profile settings page `app/(authenticated)/settings/profile/page.tsx`: Telegram section (connect/disconnect button, generate code dialog, per-type notification toggles for Telegram)
- [ ] T069 [US6] Add NotificationBell to authenticated layout header in `app/(authenticated)/layout.tsx`
- [ ] T070 [US6] Unit tests for notification.service in `tests/unit/notification.service.test.ts`: test self-notification suppression (actor === recipient), test all 4 trigger types create correct notification, test Telegram dispatch called with correct params

**Checkpoint**: Колокольчик работает, Telegram подключается и получает уведомления, retry при сбоях

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Адаптивность, финальный UX, quality gates

- [ ] T071 [P] Add responsive styles to all pages: mobile breakpoints for board (horizontal scroll), project list (stack cards), admin table (responsive columns) using Tailwind `sm:`, `md:`, `lg:`
- [ ] T072 [P] Add skeleton-UI loading states to: projects list, board columns/tasks, admin users table, notifications dropdown (Constitution XVIII)
- [ ] T073 [P] Add touch support testing: verify @dnd-kit PointerSensor works on touch devices, add `touch-action: none` CSS where needed
- [ ] T074 Review all API routes for missing Zod validation (Constitution III): ensure every route validates input with schema from `lib/schemas/` and returns typed response
- [ ] T075 [P] Verify `server-only` import in all service files and `lib/db.ts` (Constitution VI)
- [ ] T076 Run `pnpm lint && pnpm typecheck` — fix all errors
- [ ] T077 Run full smoke test per `quickstart.md` §9 checklist

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 Auth (Phase 3)**: Depends on Foundational
- **US2 Projects (Phase 4)**: Depends on US1 (needs auth)
- **US3 Board (Phase 5)**: Depends on US2 (needs projects)
- **US4 Timer (Phase 6)**: Depends on US3 (needs task movement)
- **US5 Comments/Files (Phase 7)**: Depends on US3 (needs task cards)
- **US6 Notifications (Phase 8)**: Depends on US3 (needs task/project services to integrate triggers)
- **Polish (Phase 9)**: Depends on all desired user stories

### Parallel Opportunities

- US4, US5, US6 can start in parallel after US3 is complete
- Within each phase, tasks marked [P] can run in parallel

### Within Each User Story

- Services before API routes
- API routes before UI components
- Core implementation before integration
- Tests alongside or after implementation

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US1 Auth → validate login/admin flow
4. Complete Phase 4: US2 Projects → validate project creation/membership
5. Complete Phase 5: US3 Board → validate drag&drop kanban
6. **STOP and VALIDATE**: Full kanban board works with auth
7. Deploy/demo if ready

### Incremental Delivery (P2 stories)

8. US4 Timer → live counter on task cards
9. US5 Comments/Files → task enrichment
10. US6 Notifications → team communication
11. Phase 9: Polish → responsive, skeleton-UI, final QA

### Parallel Team Strategy (after US3)

- Developer A: US4 Timer
- Developer B: US5 Comments/Files
- Developer C: US6 Notifications
- All complete independently → Phase 9 Polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Each user story independently completable and testable after US3 foundation
- Commit after each task or logical group
- Avoid: vague tasks, same file conflicts, cross-story dependencies
