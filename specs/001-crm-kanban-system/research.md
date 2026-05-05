# Research: CRM Канбан-система

**Branch**: `001-crm-kanban-system` | **Date**: 2026-05-05

Все технологические решения предоставлены разработчиком в `/speckit-plan`. Этот документ фиксирует
обоснование каждого выбора и задокументированные альтернативы.

---

## 1. Fullstack-фреймворк: Next.js 14 (App Router)

**Decision**: Next.js 14 с App Router, TypeScript strict mode.

**Rationale**:
- Server Components снижают клиентский JS-бандл для статичных частей (список проектов, карточки задач
  без интерактива).
- App Router поддерживает Route Groups для разделения `(auth)` / `(authenticated)` без изменения URL.
- API Routes в том же репозитории — монорепо без отдельного backend-сервиса.
- Тесная интеграция с NextAuth v5.

**Alternatives considered**:
- Vite + Express (separate frontend/backend) — отклонено: лишний DevOps-оверхед для MVP.
- Remix — отклонено: меньший ecosystem, команда знакома с Next.js.

---

## 2. Авторизация: NextAuth (Auth.js) v5 + Credentials Provider

**Decision**: NextAuth v5, Credentials provider (логин/email + пароль), JWT-стратегия сессии.

**Rationale**:
- Credentials provider подходит для системы без самостоятельной регистрации — администратор создаёт
  учётки, пользователи логинятся.
- JWT-стратегия: не требует отдельной таблицы сессий в SQLite; токен хранится в httpOnly cookie.
- bcrypt для хэширования паролей (cost factor 12 — баланс безопасности и скорости на локалке).

**Session strategy**: JWT без maxAge — сессия живёт до явного logout. Для мгновенной инвалидации
при деактивации пользователя: `callbacks.session` в NextAuth делает запрос `prisma.user.findUnique`
по `session.user.id` и проверяет `isActive`. Если `isActive === false`, callback возвращает `null`,
что вызывает принудительный logout на клиенте при следующем запросе (FR-004a).
Дополнительная нагрузка на БД: один SELECT по PK на каждый запрос — приемлемо для MVP (single-server).

**Password generation**: `crypto.randomBytes` → base62-кодирование → 12 символов. Показывается ADMIN
один раз через UI-диалог. Хранится только bcrypt-хэш.

**Alternatives considered**:
- Database sessions (Prisma adapter) — отклонено: для MVP JWT проще, нет дополнительных таблиц.
- Passport.js — отклонено: устаревший API, NextAuth v5 нативно интегрируется с App Router.

---

## 3. Drag & Drop: @dnd-kit

**Decision**: `@dnd-kit/core` + `@dnd-kit/sortable`.

**Rationale**:
- Поддерживает тач-устройства через Pointer Events API (нативно).
- Оптимистичные обновления: DragOverlay позволяет мгновенно отражать перетаскивание, а реальное
  состояние откатывается при ошибке сервера.
- Работает с Server Components (только DnDContext на клиенте).
- Активно поддерживается (react-beautiful-dnd — заброшен).

**Alternatives considered**:
- react-beautiful-dnd — отклонено: deprecated, нет поддержки тача.
- HTML5 Drag and Drop API напрямую — отклонено: нет поддержки тача, плохой UX на мобильных.

---

## 4. Клиентский кэш: TanStack Query v5

**Decision**: TanStack Query (React Query) v5.

**Rationale**:
- `refetchInterval` для живого таймера задачи (polling 1 сек) — нативная функция без кастомных
  useEffect.
- Оптимистичные мутации (`onMutate` / `onError` rollback) — ключевой паттерн для drag&drop.
- Автоматическая инвалидация кэша после мутаций.
- Совместим с Next.js App Router (prefetch на сервере, гидрация на клиенте).

**Alternatives considered**:
- SWR — отклонено: меньше возможностей для оптимистичных обновлений.
- Zustand + fetch — отклонено: больше бойлерплейта для cache invalidation.

---

## 5. База данных: Prisma + SQLite → PostgreSQL

**Decision**: Prisma ORM, SQLite локально (`dev.db`), PostgreSQL в проде.

**Rationale**:
- Смена провайдера: одна строка в `schema.prisma` (`provider = "sqlite"` → `"postgresql"`).
- `prisma migrate deploy` одинаково работает с обоими провайдерами.
- SQLite — нет Docker для локальной разработки.

**Migration safety (Constitution V)**:
- Перед каждой `prisma migrate deploy` в проде: `pg_dump -Fc $DATABASE_URL > backup_$(date +%Y%m%d).dump`.
- Локально: `cp prisma/dev.db prisma/dev.db.bak` перед `prisma migrate dev`.
- Оба шага задокументированы в `quickstart.md` и `package.json` скриптах.

**Alternatives considered**:
- Drizzle ORM — отклонено: менее зрелый ecosystem, команда знакома с Prisma.
- Raw SQL — отклонено: нарушает Constitution (только Prisma для работы с БД).

---

## 6. Хранилище файлов: FileStorage абстракция

**Decision**: Интерфейс `FileStorage` (upload/download/delete/getUrl), реализация `LocalStorage`.

**Rationale**:
- Constitution IX требует абстракцию.
- `STORAGE_DRIVER=local|s3` в ENV — переключение без изменения бизнес-логики.
- Путь: `uploads/{projectId}/{taskId}/{uuid}-{originalName}` — UUID предотвращает коллизии имён.
- Скачивание через защищённый Next.js route `/api/attachments/:id` с проверкой членства.

**Alternatives considered**:
- Прямой доступ к файлам через `/public/uploads` — отклонено: нет проверки прав доступа.

---

## 7. Telegram интеграция: node-telegram-bot-api (long-polling)

**Decision**: `node-telegram-bot-api`, режим long-polling для MVP.

**Rationale**:
- Long-polling не требует публичного HTTPS-домена (нет webhook URL на локалке).
- Для MVP single-server деплоя — достаточно.
- In-memory очередь с retry: 3 попытки, exponential backoff 1s/5s/30s.
- In-app уведомление создаётся в БД ДО запуска Telegram-транспорта (независимость).

**Failure handling**: после 3 неудачных попыток — `console.error` с деталями (chatId, eventType,
error). Пользователь не уведомляется об ошибке Telegram — не его ответственность.

**Alternatives considered**:
- Webhook — отклонено для MVP: требует ngrok/туннель на локалке; приберечь для prod.
- Grammy / Telegraf — отклонено: избыточно для простых уведомлений без сложного диалога.

---

## 8. Real-time таймер: polling (TanStack Query)

**Decision**: `refetchInterval: 1000` для задач в статусе "В работе".

**Rationale**:
- WebSocket / SSE — overkill для одного живого счётчика на MVP.
- Клиентский JS-таймер (setInterval) с начальным значением из сервера — достаточен для точности
  до секунды.
- При закрытии/открытии вкладки — значение синхронизируется при следующем запросе.

**Alternatives considered**:
- SSE (Server-Sent Events) — отклонено: усложняет Next.js Route Handlers; оставить для будущих
  real-time фич (live-коллаборация).
- WebSocket — отклонено: overkill для MVP.

---

## 9. UI: Tailwind CSS 3 + shadcn/ui

**Decision**: Tailwind CSS 3 + shadcn/ui компоненты (копируются в `/components/ui/`).

**Rationale**:
- shadcn/ui — не npm-пакет, а набор исходников. Не противоречит Constitution IV.
- Radix UI primitives под капотом — доступность (a11y) из коробки.
- Tailwind обеспечивает адаптивность через брейкпоинты (`sm:`, `md:`, `lg:`).

---

## 10. Тестирование: Vitest (unit)

**Decision**: Vitest для unit-тестов критичной бизнес-логики.

**Scope**: `timer.service`, `notification.service`, `LocalStorage`.

**Rationale**:
- Vitest — нативная интеграция с Vite/Next.js, совместим с TypeScript из коробки.
- E2E (Playwright) — отложен после MVP.

---

## Resolved NEEDS CLARIFICATION

Все пункты из спеки и уточнений разрешены. Нерешённых вопросов нет.
