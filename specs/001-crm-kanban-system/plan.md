# Implementation Plan: CRM Канбан-система управления проектами и задачами

**Branch**: `001-crm-kanban-system` | **Date**: 2026-05-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-crm-kanban-system/spec.md`

## Summary

Командная CRM с канбан-доской (Trello-подобная), учётом времени в колонке «В работе» и
Telegram-уведомлениями. Fullstack-приложение на Next.js 14 (App Router), Prisma + SQLite (dev) /
PostgreSQL (prod), NextAuth v5 (Credentials + JWT), @dnd-kit для drag&drop, TanStack Query v5
для клиентского кэша и polling живого таймера.

## Technical Context

**Language/Version**: TypeScript 5.x (strict mode), Node.js 20+
**Primary Dependencies**: Next.js 14, Prisma 5, NextAuth v5, @dnd-kit, TanStack Query v5, Zod, shadcn/ui, Tailwind CSS 3, bcrypt, node-telegram-bot-api, date-fns, Vitest
**Storage**: SQLite (dev) / PostgreSQL (prod) через Prisma; файлы — LocalStorage `./uploads/`
**Testing**: Vitest (unit: timer.service, notification.service, FileStorage)
**Target Platform**: Web (адаптивный: 320px–2560px, тач-поддержка через @dnd-kit Pointer Events)
**Project Type**: Fullstack web-application (monorepo, single Next.js instance)
**Performance Goals**: Загрузка доски (50 задач) < 2 сек P95 локально; drag&drop оптимистичный (мгновенно); таймер polling 1 сек
**Constraints**: Single-server деплой; in-memory Telegram retry очередь; без WebSocket/SSE в MVP
**Scale/Scope**: Малая команда (~10–50 пользователей); ~10 проектов; ~500 задач на проект

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I** — pnpm единственный менеджер пакетов; `.npmrc engine-strict=true`
- [x] **II** — `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`; `any` запрещён; Zod для unknown
- [x] **III** — Все API routes валидируются через Zod schemas (см. `/lib/schemas/`); контракты в `contracts/api.md`
- [x] **IV** — Все пакеты обоснованы в `research.md` (разделы 1–10)
- [x] **V** — `quickstart.md` §3 содержит обязательный шаг backup перед миграцией; скрипт `db:migrate` документирован
- [x] **VI** — `lib/db.ts`, `lib/auth.ts`, все services помечены `import "server-only"`
- [x] **VII** — `.env.example` содержит все переменные; секреты только в `.env` (gitignored)
- [x] **VIII** — Вся бизнес-логика в `/lib/services/`; API routes = валидация + вызов сервиса
- [x] **IX** — Все файловые операции через `FileStorage` интерфейс (`lib/services/storage/`)
- [x] **X** — Все уведомления через `notification.service.ts` (in-app + Telegram)
- [x] **XIV** — Conventional Commits + Husky pre-commit hook
- [x] **XIX** — Загрузка доски: один `prisma.project.findUnique` с `include` (columns → tasks → assignee); нет N+1
- [x] **XX** — Пагинация на: `/api/projects`, `/api/admin/users`, `/api/notifications`, `/api/tasks`

**Session strategy**: JWT без maxAge (до явного logout). При деактивации пользователя — `callbacks.session`
в NextAuth проверяет `User.isActive` из БД; если `false` → возвращает `null` → принудительный logout.
Это обеспечивает мгновенную инвалидацию всех JWT-сессий деактивированного пользователя.

## Project Structure

### Documentation (this feature)

```text
specs/001-crm-kanban-system/
├── plan.md          # этот файл
├── research.md      # обоснование технологических решений
├── data-model.md    # Prisma schema + бизнес-правила
├── quickstart.md    # инструкция по запуску
├── contracts/
│   └── api.md       # REST API контракты
└── tasks.md         # создаётся /speckit-tasks
```

### Source Code (repository root)

```text
app/
├── (auth)/
│   └── login/
│       └── page.tsx
├── (authenticated)/
│   ├── layout.tsx                  # проверка сессии + провайдеры
│   ├── projects/
│   │   ├── page.tsx                # список проектов
│   │   └── [id]/
│   │       └── page.tsx            # доска проекта
│   ├── admin/
│   │   └── users/
│   │       └── page.tsx
│   └── settings/
│       └── profile/
│           └── page.tsx
└── api/
    ├── auth/[...nextauth]/route.ts
    ├── projects/route.ts           # GET, POST
    ├── projects/[id]/route.ts      # GET, PATCH, DELETE
    ├── projects/[id]/members/route.ts
    ├── projects/[id]/members/[userId]/route.ts
    ├── projects/[id]/columns/route.ts
    ├── columns/[id]/route.ts       # PATCH, DELETE
    ├── columns/[id]/position/route.ts
    ├── projects/[id]/tasks/route.ts
    ├── tasks/[id]/route.ts         # GET, PATCH, DELETE
    ├── tasks/[id]/move/route.ts    # POST (атомарная транзакция)
    ├── tasks/[id]/position/route.ts
    ├── tasks/[id]/comments/route.ts
    ├── comments/[id]/route.ts
    ├── tasks/[id]/attachments/route.ts
    ├── attachments/[id]/route.ts   # GET (download), DELETE
    ├── notifications/route.ts
    ├── notifications/read/route.ts
    ├── profile/telegram/generate-code/route.ts
    ├── profile/telegram/disconnect/route.ts
    ├── admin/users/route.ts
    ├── admin/users/[id]/deactivate/route.ts
    ├── admin/users/[id]/activate/route.ts
    ├── admin/users/[id]/role/route.ts
    └── admin/users/[id]/reset-password/route.ts

components/
├── ui/                             # shadcn/ui примитивы
├── board/
│   ├── Board.tsx                   # DnDContext, колонки
│   ├── Column.tsx                  # SortableContext для задач
│   ├── TaskCard.tsx                # карточка + живой таймер
│   └── TaskModal.tsx               # модальное окно задачи
└── forms/

lib/
├── db.ts                           # Prisma client singleton ("server-only")
├── auth.ts                         # NextAuth config ("server-only")
├── schemas/
│   ├── user.schema.ts
│   ├── project.schema.ts
│   ├── column.schema.ts
│   ├── task.schema.ts
│   ├── comment.schema.ts
│   ├── attachment.schema.ts
│   └── notification.schema.ts
└── services/
    ├── auth.service.ts             ("server-only")
    ├── project.service.ts          ("server-only")
    ├── task.service.ts             ("server-only")
    ├── timer.service.ts            ("server-only")
    ├── notification.service.ts     ("server-only")
    ├── storage/
    │   ├── types.ts                # FileStorage interface
    │   ├── local.storage.ts
    │   └── index.ts                # factory: STORAGE_DRIVER
    └── telegram/
        ├── bot.ts                  # long-polling init
        └── sender.ts               # retry queue

prisma/
├── schema.prisma
└── seed.ts                         # создание первого ADMIN

scripts/
└── create-user.ts                  # CLI утилита

tests/
└── unit/
    ├── timer.service.test.ts
    ├── notification.service.test.ts
    └── local.storage.test.ts

uploads/                            # gitignored
.env.example
```

**Structure Decision**: Fullstack Next.js monorepo (единственный процесс). Frontend и backend
не разделены на отдельные папки — используем App Router и Route Groups Next.js.

## Complexity Tracking

> Нарушений конституции нет. Раздел заполнен для документирования одного обоснованного отступления.

| Отступление | Почему нужно | Более простая альтернатива отклонена потому что |
|-------------|-------------|------------------------------------------------|
| `POST /api/tasks/:id/move` — отдельный эндпоинт вместо `PATCH` | Атомарная транзакция из 6 операций (Task + MoveLog + TimeInterval + Notification); обычный PATCH не выражает семантику «переместить» | `PATCH /api/tasks/:id` с `columnId` смешал бы «редактировать поля» и «переместить», усложнил бы логику транзакции и тестирование |
