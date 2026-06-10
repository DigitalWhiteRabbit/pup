# FUNCTIONAL_MAP

Карта фактического функционала платформы ПУП (Пульт Управления Проектами).
Три независимых процесса: PUP (Next.js), YT Parser (Express), TG Service (FastAPI).

---

## Стек

### PUP (основное приложение)

- **Язык / фреймворк:** TypeScript, Next.js 14 App Router (Turbopack dev)
- **UI:** React 18, shadcn/ui (Radix), TailwindCSS, dnd-kit, TanStack Query, react-hook-form
- **БД:** Prisma ORM — SQLite (dev) / PostgreSQL (prod)
- **Auth:** next-auth 5.0.0-beta.25 (JWT, Credentials provider) + Service Accounts (Bearer M2M)
- **AI:** @anthropic-ai/sdk (Claude Sonnet/Haiku/Opus)
- **Транскрипция:** Groq Whisper API (whisper-large-v3)
- **Email:** Resend (отправка), ImapFlow (чтение), Nodemailer (SMTP)
- **Telegram:** node-telegram-bot-api (admin-бот)
- **Голос:** WebRTC mesh (STUN/TURN через Metered.ca)
- **Реалтайм:** SSE (chat), polling (voice signaling, fallback chat)
- **Документы:** pdf-parse, mammoth (DOCX), exceljs (XLSX), Cheerio (HTML)
- **Безопасность:** bcrypt, AES-256-GCM (lib/services/crypto), DOMPurify, CSP, rate limiting
- **CI/CD:** GitHub Actions (typecheck + lint + test + build), Husky + lint-staged
- **Деплой:** PM2, nginx, GitHub webhook → deploy.sh → Telegram уведомления

### YT Parser (tools/yt-parser)

- **Язык / фреймворк:** JavaScript (CommonJS), Express 5
- **БД:** better-sqlite3, по одной базе на workspace (`db/ws-{id}.db`)
- **AI:** @anthropic-ai/sdk (Sonnet — pitch, Haiku — summary/translation, Opus — complex)
- **Embeddings:** @xenova/transformers (multilingual-e5-small, локально, без GPU)
- **Email:** Resend + ImapFlow
- **Telegram:** gramjs (user-bot MTProto) + node-telegram-bot-api (admin-bot)
- **YouTube:** googleapis (YouTube Data API v3), yt-comment-scraper
- **Документы:** pdf-parse, mammoth, Cheerio + Readability (crawl)
- **Деплой:** PM2, порт 3001

### TG Service (tools/tg-service)

- **Язык / фреймворк:** Python 3.12, FastAPI, Pydantic
- **БД:** SQLite per-workspace (`data/ws-{id}.db`), 40+ таблиц
- **Очередь задач:** Celery + Redis (db=5)
- **Telegram:** Telethon (MTProto), python-socks
- **AI:** anthropic SDK (Claude Haiku/Sonnet/Opus)
- **Embeddings:** sentence-transformers / fastembed (локально)
- **Proxy:** HTTP, SOCKS5, MTProto; интеграция Proxy Seller API
- **Шифрование:** AES-256-GCM (Telethon-сессии)
- **Логирование:** structlog (JSON)
- **Деплой:** PM2 (uvicorn), порт 8001

---

## Фичи (продуктовый взгляд)

---

### Фича: Аутентификация и управление пользователями

- **Что делает:** Логин по email/login + пароль, JWT-сессии, управление ролями (ADMIN / USER), деактивация, сброс пароля, привязка Telegram через одноразовый код.
- **Точки входа:**
  - `app/api/auth/[...nextauth]/route.ts` — NextAuth (GET, POST)
  - `app/api/admin/users/route.ts` — CRUD пользователей (GET, POST)
  - `app/api/admin/users/[id]/activate/route.ts` — PATCH
  - `app/api/admin/users/[id]/deactivate/route.ts` — PATCH
  - `app/api/admin/users/[id]/reset-password/route.ts` — PATCH
  - `app/api/admin/users/[id]/role/route.ts` — PATCH
  - `app/api/profile/telegram/generate-code/route.ts` — POST
  - `app/api/profile/telegram/disconnect/route.ts` — POST
  - `app/api/profile/password/route.ts` — PATCH
  - `app/api/profile/avatar/route.ts` — POST (загрузка аватара)
  - `app/api/profile/notifications/route.ts` — GET, PATCH
  - `app/api/profile/telegram/preferences/route.ts` — GET, PATCH (настройки TG-уведомлений)
  - `app/api/profile/telegram/status/route.ts` — GET (статус привязки Telegram)
  - `app/api/users/all/route.ts` — GET (список всех пользователей)
  - `app/api/users/online/route.ts` — GET (онлайн-статус)
  - `app/api/users/[userId]/avatar/route.ts` — GET (аватар пользователя)
  - Экран: `/login`, `/settings/profile`, `/admin/users`
- **От чего зависит:** Prisma (User, TelegramLinkToken), bcrypt, jose (JWT), next-auth, `lib/middleware/with-auth.ts` (middleware аутентификации), `lib/services/storage/` (хранение аватаров)
- **Happy-path:** Пользователь логинится → получает JWT → ADMIN может создавать/деактивировать аккаунты → пользователь привязывает Telegram через код
- **Edge-cases:** In-memory кэш isActive (60s TTL) — деактивированный пользователь может действовать до 60 секунд. Rate limiting на /auth/callback/credentials (IP-based).

---

### Фича: Service Accounts (M2M API)

- **Что делает:** Создание токенов для машинного доступа (M2M). Каждый токен привязан к workspace, имеет набор scopes и опциональный IP whitelist.
- **Точки входа:**
  - `app/api/admin/service-accounts/route.ts` — GET, POST
  - `app/api/admin/service-accounts/[id]/route.ts` — GET, PATCH, DELETE
  - `app/api/v1/[workspaceId]/` — 9 public API routes (tickets, kb, customers, leads, tasks, marketing/analytics, users, dashboard)
  - `lib/middleware/resolve-auth.ts` — unified Bearer / session resolution
  - `lib/middleware/with-service-auth.ts` — scope enforcement, rate limit 1000 req/hour
- **От чего зависит:** Prisma (ServiceAccount), SHA-256 hash токена
- **Happy-path:** Admin создает service account → получает Bearer token → внешняя система делает запросы к `/api/v1/` с токеном → middleware проверяет scope, workspace, IP
- **Edge-cases:** IP whitelist = null означает доступ с любого IP

---

### Фича: Workspaces (рабочие пространства)

- **Что делает:** Создание и управление изолированными пространствами. Каждый workspace содержит 8 модулей (crm, knowledge, tickets, logs, chat, marketing, analytics, users), которые можно включать/отключать. Участники имеют роли (OWNER, MEMBER) и опциональные ограничения по модулям (allowedModules JSON).
- **Точки входа:**
  - `app/api/workspaces/route.ts` — GET, POST
  - `app/api/workspaces/[id]/route.ts` — GET, PATCH, DELETE
  - `app/api/workspaces/[id]/logo/route.ts` — POST
  - `app/api/workspaces/[id]/modules/route.ts` — GET, PATCH
  - `app/api/workspaces/[id]/members/route.ts` — GET, POST
  - `app/api/workspaces/[id]/members/[userId]/route.ts` — GET, PATCH, DELETE
  - `app/api/workspaces/[id]/members/[userId]/modules/route.ts` — GET
  - `app/api/workspaces/[id]/my-modules/route.ts` — GET (текущий пользователь)
  - `app/api/workspaces/[id]/members-activity/route.ts` — GET
  - `app/api/workspaces/[id]/members/[userId]/activity/route.ts` — GET
  - Экран: `/workspaces`, `/workspaces/[id]`
- **От чего зависит:** Prisma (Workspace, WorkspaceMember, WorkspaceModule, MemberActivity), `lib/services/workspace.service.ts`, `lib/services/member.service.ts`, `lib/services/column.service.ts`
- **Happy-path:** Пользователь создает workspace → добавляет участников → включает нужные модули → участники видят только разрешенные модули
- **Edge-cases:** Global ADMIN может управлять участниками любого workspace. allowedModules поддерживает вложенные ключи (e.g. `marketing:parsers:youtube`).

---

### Фича: CRM / Kanban-доска

- **Что делает:** Доска с колонками и карточками задач. Drag-and-drop перетаскивание задач между колонками. Задачи имеют приоритет, сроки, исполнителей, метки, чек-листы, комментарии, вложения. Учет времени (start/stop интервалы). История перемещений между колонками.
- **Точки входа:**
  - `app/api/workspaces/[id]/columns/route.ts` — GET, POST
  - `app/api/columns/[id]/route.ts` — GET, PATCH, DELETE
  - `app/api/columns/[id]/position/route.ts` — POST (reorder)
  - `app/api/workspaces/[id]/tasks/route.ts` — GET, POST
  - `app/api/tasks/[id]/route.ts` — GET, PATCH, DELETE
  - `app/api/tasks/[id]/position/route.ts` — POST (move)
  - `app/api/tasks/[id]/comments/route.ts` — GET, POST
  - `app/api/comments/[id]/route.ts` — PATCH, DELETE
  - `app/api/tasks/[id]/checklist/route.ts` — GET, POST
  - `app/api/checklist/[id]/route.ts` — PATCH, DELETE
  - `app/api/tasks/[id]/attachments/route.ts` — GET, POST
  - `app/api/attachments/[id]/route.ts` — GET, DELETE
  - `components/board/Board.tsx`, `Column.tsx`, `TaskCard.tsx`, `TaskModal.tsx`
  - Экран: `/workspaces/[id]/crm`
- **От чего зависит:** Prisma (Column, Task, TaskAssignee, Label, TaskLabel, ChecklistItem, TimeInterval, ColumnMoveLog, Comment, Attachment), dnd-kit, `lib/services/task.service.ts`, `lib/services/column.service.ts`, `lib/services/comment.service.ts`, `lib/services/attachment.service.ts`, `lib/services/timer.service.ts`
- **Happy-path:** Создать колонки → создать задачу → назначить исполнителей → перетащить между колонками → добавить комментарии/файлы → отслеживать время
- **Edge-cases:** position — целое число для упорядочивания, пересчитывается при drag-drop

---

### Фича: База знаний (Knowledge Base)

- **Что делает:** Статьи в Markdown с категориями, тегами, версионированием. Импорт из файлов (PDF, DOCX, XLSX, TXT), URL, краулинг сайтов (рекурсивный spider с глубиной). Полнотекстовый поиск. Хранение файлов с автоизвлечением текста.
- **Точки входа:**
  - `app/api/workspaces/[id]/kb/articles/route.ts` — GET, POST
  - `app/api/kb/articles/[articleId]/route.ts` — GET, PATCH, DELETE
  - `app/api/kb/articles/[articleId]/history/route.ts` — GET
  - `app/api/kb/articles/[articleId]/restore/[versionId]/route.ts` — POST
  - `app/api/workspaces/[id]/kb/search/route.ts` — GET
  - `app/api/workspaces/[id]/kb/categories/route.ts` — GET, POST
  - `app/api/workspaces/[id]/kb/categories/reorder/route.ts` — POST
  - `app/api/workspaces/[id]/kb/tags/route.ts` — GET, POST
  - `app/api/workspaces/[id]/kb/files/route.ts` — GET, POST
  - `app/api/workspaces/[id]/kb/import/file/route.ts` — POST
  - `app/api/workspaces/[id]/kb/import/url/route.ts` — POST
  - `app/api/workspaces/[id]/kb/import/url/preview/route.ts` — POST
  - `app/api/workspaces/[id]/kb/import/crawl/route.ts` — POST
  - `app/api/workspaces/[id]/kb/crawls/route.ts` — GET
  - `app/api/kb/crawls/[crawlId]/route.ts` — GET, PATCH
  - `app/api/kb/crawls/[crawlId]/cancel/route.ts` — POST
  - `app/api/kb/files/[fileId]/content/route.ts` — GET (скачивание содержимого файла)
  - Экран: `/workspaces/[id]/knowledge`, `/workspaces/[id]/knowledge/new`, `/workspaces/[id]/knowledge/[articleId]/edit`
- **От чего зависит:** Prisma (KbArticle, KbArticleVersion, KbCategory, KbTag, KbFile, KbCrawl, KbCrawlPage, KbSearchHistory), `lib/services/kb/` (10 сервисов), `lib/services/storage/` (хранение файлов), pdf-parse, mammoth, exceljs, Cheerio, Turndown
- **Happy-path:** Создать категорию → создать статью (Markdown) → загрузить файлы → текст извлекается автоматически → поиск находит статьи + тикеты
- **Edge-cases:** Краулинг ограничен: maxPages (500), maxDepth (5), timeout (15 мин). SSRF-защита при импорте URL (проверка private IP). Поле embedding зарезервировано для KB-2 (Voyage AI), пока не используется.

---

### Фича: Тикеты и поддержка

- **Что делает:** Система тикетов с SLA, приоритетами, статусами (OPEN → IN_PROGRESS → WAITING_CUSTOMER → RESOLVED → CLOSED). Назначение агентов, коллабораторы. Публичный чат-виджет (embed в iframe), где клиент создает тикет и общается. AI-агент (Claude) может отвечать автоматически (copilot/autopilot mode), искать в базе знаний, определять уверенность и передавать человеку. Шаблоны ответов (canned responses). CSAT-оценка. Email-тикеты (inbound webhook).
- **Точки входа:**
  - `app/api/workspaces/[id]/tickets/route.ts` — GET, POST
  - `app/api/workspaces/[id]/tickets/bulk-delete/route.ts` — POST
  - `app/api/workspaces/[id]/tickets/analytics/route.ts` — GET
  - `app/api/tickets/[ticketId]/route.ts` — GET, PATCH, DELETE
  - `app/api/tickets/[ticketId]/assign/route.ts` — POST
  - `app/api/tickets/[ticketId]/status/route.ts` — PATCH
  - `app/api/tickets/[ticketId]/messages/route.ts` — GET, POST
  - `app/api/tickets/[ticketId]/collaborators/route.ts` — GET, POST
  - `app/api/tickets/[ticketId]/ai/suggest/route.ts` — POST
  - `app/api/tickets/[ticketId]/ai/summarize/route.ts` — POST
  - `app/api/workspaces/[id]/customers/route.ts` — GET, POST
  - `app/api/workspaces/[id]/agent/config/route.ts` — GET, PATCH (конфигурация AI-агента)
  - `app/api/workspaces/[id]/canned-responses/route.ts` — GET, POST
  - `app/api/workspaces/[id]/email/config/route.ts` — GET, PATCH
  - `app/api/customers/[customerId]/route.ts` — GET, PATCH, DELETE (CRUD отдельного клиента)
  - `app/api/email/inbound/[workspaceId]/route.ts` — POST (webhook)
  - Публичный виджет: `app/api/chat/[slug]/` (config, identify, tickets, messages, rate)
  - Экран: `/workspaces/[id]/tickets`, настройки agent/email/canned
- **От чего зависит:** Prisma (Ticket, TicketMessage, Customer, CannedResponse, AgentConfig, AgentScenario, TicketRating, TicketCollaborator, WorkspaceEmailConfig), `lib/services/tickets/` (7 сервисов), `lib/services/agent/agent.service.ts`, Anthropic SDK, Resend, ImapFlow
- **Happy-path:** Клиент открывает виджет → идентифицируется по email → создает тикет → AI-агент отвечает из KB → если не уверен — передает человеку → менеджер закрывает → клиент ставит CSAT-оценку
- **Edge-cases:** AI-агент имеет handoffThreshold (0.7 по умолчанию) — ниже передает человеку. AgentScenario позволяет настроить сценарии с инструкциями. Публичный API защищен CORS + customer JWT token (не сессия).

---

### Фича: Внутренний мессенджер (Chat)

- **Что делает:** Каналы (GENERAL, PUBLIC, PRIVATE, DM). Сообщения с тредами (ответы), реакциями (emoji), закладками, пересылкой, пинами, вложениями. Поиск каналов. Typing indicators. Реалтайм через SSE. Мут каналов. Глобальный чат (вне workspace).
- **Точки входа:**
  - `app/api/workspaces/[id]/chat-channels/route.ts` — GET, POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/route.ts` — GET, PATCH, DELETE
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/route.ts` — GET, POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/route.ts` — PATCH, DELETE
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/reactions/route.ts` — POST, DELETE
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/bookmark/route.ts` — POST, DELETE
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/forward/route.ts` — POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/thread/route.ts` — GET, POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/messages/[messageId]/pin/route.ts` — POST, DELETE
  - `app/api/workspaces/[id]/chat-channels/[channelId]/typing/route.ts` — POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/read/route.ts` — POST
  - `app/api/workspaces/[id]/chat-channels/[channelId]/mute/route.ts` — POST
  - `app/api/workspaces/[id]/chat-channels/dm/route.ts` — POST
  - `app/api/workspaces/[id]/chat-channels/events/route.ts` — GET (SSE)
  - `app/api/link-preview/route.ts` — POST (превью ссылок в сообщениях)
  - `app/api/global-chat/route.ts` — GET, POST
  - `app/api/bookmarks/route.ts` — GET
  - Экран: `/workspaces/[id]/chat`, global chat
- **От чего зависит:** Prisma (ChatChannel, ChatChannelMember, ChatMsg, ChatMsgReaction, ChatMsgAttachment, ChatMsgBookmark, GlobalChatMsg, GlobalChatAttachment, GlobalChatReaction), `lib/services/chat-internal/` (channel, message, sse), `lib/services/storage/` (вложения), SSE
- **Happy-path:** Открыть канал → писать сообщения → получать их в реалтайме через SSE → отвечать в треды → ставить реакции → пересылать
- **Edge-cases:** SSE keep-alive каждые 25s. Fallback polling 30s при потере SSE. Soft delete сообщений (deletedAt). GENERAL канал автосоздается и не удаляется.

---

### Фича: Голосовые каналы (Voice)

- **Что делает:** WebRTC mesh-аудио. Комнаты с участниками (пользователи + гости). Screen sharing. Запись → транскрипция (Groq Whisper) → AI-саммари (Claude). Инвайт-ссылки для гостей. Текстовый чат внутри комнаты. История сессий. Это отдельный модуль, не связанный с Analytics.
- **Точки входа:**
  - `app/api/voice/ice-servers/route.ts` — GET (STUN/TURN config)
  - `app/api/workspaces/[id]/voice/rooms/route.ts` — GET, POST
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/route.ts` — GET, PATCH, DELETE
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/signal/route.ts` — GET, POST (WebRTC signaling)
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/participants/route.ts` — GET
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/messages/route.ts` — GET, POST
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/heartbeat/route.ts` — POST
  - `app/api/workspaces/[id]/voice/rooms/[roomId]/recording/route.ts` — POST, GET
  - `app/api/workspaces/[id]/voice/sessions/route.ts` — GET
  - `app/api/workspaces/[id]/voice/invite/route.ts` — POST
  - `app/api/transcribe/route.ts` — POST
  - Экран: `/workspaces/[id]/analytics` (текущий URL, но фактически voice rooms), `/voice-join` (гостевой вход)
- **От чего зависит:** Prisma (VoiceRoom, VoiceParticipant, VoiceSignal, VoiceMessage, VoiceSession), Groq Whisper API, Anthropic SDK, Metered.ca TURN
- **Happy-path:** Создать комнату → войти → WebRTC-соединение через polling signaling → говорить → записать → AI транскрибирует и суммаризирует
- **Edge-cases:** Signaling через polling (не WebSocket). Heartbeat для отслеживания живых участников. Приватные комнаты с whitelist userIds.

---

### Фича: Analytics (внешний redirect)

- **Что делает:** Модуль аналитики работает по той же логике, что и Users — подключается внешний URL аналитики для каждого workspace. Текущее состояние: redirect настроен только для workspace Ananas.
- **Точки входа:**
  - Поле `externalAnalyticsUrl` в модели Workspace
  - Экран: `/workspaces/[id]/analytics` (делит URL path с Voice — требует разделения)
- **От чего зависит:** Prisma (Workspace.externalAnalyticsUrl)
- **Happy-path:** Workspace имеет externalAnalyticsUrl → при открытии модуля Analytics → redirect/iframe на внешний дашборд

---

### Фича: Логи и аналитика активности

- **Что делает:** Полный аудит-лог всех действий (70+ типов ActivityAction). Системные логи (уровни INFO/WARN/ERROR). Учет времени участников (heartbeat-based). Click tracking. Дифф-view для изменений.
- **Точки входа:**
  - `app/api/workspaces/[id]/logs/activity/route.ts` — GET
  - `app/api/workspaces/[id]/logs/system/route.ts` — GET
  - `app/api/activity-log/route.ts` — GET (global)
  - `app/api/workspaces/[id]/members/[userId]/click-logs/route.ts` — GET
  - `app/api/workspaces/[id]/click-logs/route.ts` — GET (клик-логи на уровне workspace)
  - `app/api/users/heartbeat/route.ts` — POST
  - Экран: `/workspaces/[id]/logs`, `/logs`
- **От чего зависит:** Prisma (ActivityLog, SystemLog, MemberActivity, MemberClickLog), `lib/services/logger.service.ts`, `lib/services/action-tracker.ts`
- **Happy-path:** Любое действие пользователя логируется → фильтрация по типу/дате/пользователю → timeline view → diff для изменений

---

### Фича: Уведомления

- **Что делает:** In-app уведомления (ASSIGNED, COMMENTED, MOVED, PROJECT_ADDED). Telegram-уведомления (admin-бот, per-user настройки). Toast popups + Web Audio звук. Уведомления о деплое.
- **Точки входа:**
  - `app/api/notifications/route.ts` — GET, POST
  - `app/api/notifications/read/route.ts` — POST
  - `app/api/notifications/unread-count/route.ts` — GET
  - `app/api/notifications/chat-updates/route.ts` — GET
  - `lib/services/notification.service.ts`
  - `lib/services/telegram/sender.ts` — отправка в TG
  - `components/notifications/NotificationBell.tsx`
- **От чего зависит:** Prisma (Notification), Telegram Bot API
- **Happy-path:** Действие (назначение, комментарий) → создание Notification → bell badge → опционально TG-сообщение

---

### Фича: Модуль Users (универсальный внешний API коннектор)

- **Что делает:** Каждый workspace подключает внешний API своего продукта для просмотра пользователей. 10-tab UI (overview, activity, logs, operations, wallets, statuses, referral-tree, risks). PUP проксирует запросы к настроенному apiEndpoint. Аналогичная логика у модуля Analytics (внешний redirect).
- **Точки входа:**
  - `app/api/workspaces/[id]/external-users/route.ts` — GET, POST
  - `app/api/workspaces/[id]/external-users/proxy/route.ts` — GET
  - `components/users/tabs/` — 8 вкладок UI
  - Экран: `/workspaces/[id]/users`
- **От чего зависит:** Prisma (ExternalUsersConfig), внешний API (apiEndpoint + apiKey в конфиге, authType: bearer / x-api-key / query)
- **Happy-path:** Каждый workspace настраивает свой apiEndpoint → PUP проксирует запросы → данные отображаются в 10-tab UI
- **Edge-cases:** SSRF-защита на apiEndpoint. Если apiEndpoint не настроен — модуль показывает форму подключения.

---

### Фича: Marketing — Hub модулей (⚠️ требует переделки)

- **Что делает (текущее состояние):** PUP содержит полный Marketing модуль с лидами, worker'ом, AI pitch, email, IMAP, scoring — **deprecated, дублирует YT Parser**. Весь реальный outreach идёт через YT Parser (`tools/yt-parser/`).
- **Целевое состояние:** При клике на "Маркетинг" в сайдбаре открывается экран выбора инструмента (карточки: YT Parser, TG Service, и т.д.). Каждая карточка открывает соответствующий standalone-инструмент в iframe.
- **Прокси к TG Service:** `app/api/workspaces/[id]/tg-service/[...path]/route.ts` — проксирует запросы из PUP к TG Service backend.
- **Текущие точки входа (deprecated, подлежат удалению):**
  - `app/api/workspaces/[id]/marketing/*` — 26 route файлов
  - `lib/services/marketing/` — 8 сервисов
  - Prisma-модели: MktConfig, MktProject, MktLead, MktDialogue, MktMessage, MktDeal, MktPendingReply, MktConsultation, MktTemplate, MktSegment, MktKnowledgeDoc, MktKnowledgeChunk, MktDailyCounter, MktLeadEmail, MktSetting, MktSearchTask, MktSearchRun
  - Экран: `/workspaces/[id]/marketing`

---

### Фича: YouTube Parser (tools/yt-parser)

- **Что делает:** Парсинг YouTube-каналов по ключевым словам. Обогащение (подписчики, ER, видео, контакты). AI-скоринг лидов. AI pitch generation (Claude). Email outreach (Resend + IMAP). Review mode с side-by-side переводом. Follow-up'ы. Deal/consultation tracking. Трекинг открытий email (пиксель). GDPR unsubscribe. RAG база знаний (локальные embeddings). Пресеты поиска. Аналитика.
- **Точки входа:**
  - `tools/yt-parser/server.js` — Express app, порт 3001
  - `/api/parse` — POST (запуск парсера, SSE прогресс)
  - `/api/stop` — POST (остановка парсера)
  - `/api/status` — GET (статус парсера)
  - `/api/progress` — GET (прогресс текущего парсинга)
  - `/api/results` — GET (каналы из CSV + статусы из DB)
  - `/api/leads/*` — CRUD лидов (promote, score, enrich, deep-summary, bulk)
  - `/api/projects/*` — CRUD кампаний (activate, test-pitch, default-prompt)
  - `/api/agent/*` — управление worker'ом (start/stop/tick/logs/chat)
  - `/api/dialogues/*` — диалоги с лидами
  - `/api/pending-replies/*` — очередь на review (approve/reject/regenerate/translate/force-send)
  - `/api/deals/*` — одобрение/отклонение сделок
  - `/api/consultations/*` — ответы AI-агенту
  - `/api/settings/*` — review mode, followup, email config
  - `/api/knowledge/*` — RAG docs (text/url/upload/crawl/reindex)
  - `/api/api-keys/*` — пул YouTube API ключей
  - `/api/presets` — GET, POST, DELETE (пресеты поиска)
  - `/api/history` — GET, DELETE (история парсингов)
  - `/api/analytics` — GET (аналитика outreach)
  - `/api/quota` — GET (квота YouTube API ключей)
  - `/api/logs` — GET (логи worker'а)
  - `/api/deleted` — GET, POST, DELETE (управление удалёнными каналами)
  - `/api/download` — GET (скачивание результатов CSV)
  - `/api/track/open/:id.png` — tracking pixel
  - `/unsubscribe` — GDPR unsubscribe
  - `/api/dev-tasks/*` — стадии/задачи разработки
  - UI: `tools/yt-parser/public/index.html` (SPA, dark/light)
  - Логин: `tools/yt-parser/public/login.html`
- **От чего зависит:** better-sqlite3, YouTube Data API v3, Anthropic SDK, Resend, ImapFlow, gramjs, @xenova/transformers, Cheerio/Readability
- **Happy-path:** Настроить ключевые слова → парсить → promote в лиды → AI скорит → запустить worker → AI пишет pitch → review → отправка → IMAP ловит ответ → AI отвечает → deal
- **Edge-cases:** Per-workspace SQLite DB. API key pool с ротацией и квотами. AI prompt caching. Rate limiting на логин (5 попыток → 10 мин блок). DRY_RUN mode.

---

### Фича: TG Service — Управление аккаунтами Telegram

- **Что делает:** Пул Telegram-аккаунтов (MTProto через Telethon). Импорт сессий (JSON, ZIP с .session). Проверка статуса через реальное подключение. Spamblock-проверка. Диагностика возможностей. Экспорт. Статусы: IMPORTED → ACTIVE → WARMING → PAUSED → FLOOD_WAIT → SPAM_BLOCKED → BANNED → DEAD.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/accounts.py` — 14 endpoints
  - `/accounts` — GET, POST (list, create)
  - `/accounts/{id}` — GET, PATCH, DELETE
  - `/accounts/bulk-import` — POST
  - `/accounts/import-zip` — POST
  - `/accounts/{id}/check-telegram` — POST (Telethon check)
  - `/accounts/bulk-check-telegram` — POST
  - `/accounts/{id}/check-spamblock` — POST
  - `/accounts/{id}/diagnose` — POST (capability tests)
  - `/accounts/{id}/export` — GET (ZIP)
  - `/accounts/stats` — GET
  - `/accounts/bulk-action` — POST
  - UI: `tools/tg-service/public/index.html` (SPA)
- **От чего зависит:** SQLite (tg_accounts), Telethon, AES-256-GCM (сессии), python-socks
- **Happy-path:** Импорт ZIP с сессиями → bulk check → рабочие помечаются ACTIVE → назначение на кампании
- **Edge-cases:** 2FA поддержка при check. Concurrency limit 3-10 при bulk check. Device fingerprint: iPhone 14 Pro, iOS 17.5.1.

---

### Фича: TG Service — Управление прокси

- **Что делает:** Пул прокси (HTTP, SOCKS5, MTProto). Типы: RESIDENTIAL, MOBILE, DATACENTER. TCP-проверка с замером latency. Авто-назначение на аккаунты (стратегии: geo_matching, equal_distribution, fill_one_first). Интеграция с Proxy Seller API (покупка, импорт, баланс).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/proxies.py` — 10 endpoints
  - `tools/tg-service/app/api/v1/proxy_seller.py` — 8 endpoints
- **От чего зависит:** SQLite (tg_proxies), httpx, Proxy Seller API
- **Happy-path:** Импорт прокси → check all → auto-assign к аккаунтам по гео → аккаунты работают через назначенные прокси

---

### Фича: TG Service — Парсинг аудиторий

- **Что делает:** 8 режимов парсинга: CHAT_MEMBERS, COMMENTERS, WRITERS, REACTIONS, POLLS, JOINERS, TOPICS, GLOBAL_SEARCH. Результат — аудитория (список пользователей с user_id, username, is_premium). Merge аудиторий, экспорт CSV/JSON. AI-скоринг/категоризация участников.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/parser.py` — 7 endpoints (CRUD tasks + start/pause/cancel)
  - `tools/tg-service/app/api/v1/audiences.py` — 7 endpoints (list/get/create/delete/members/merge/export)
  - `tools/tg-service/app/tasks/parsing_tasks.py` — Celery задачи
- **От чего зависит:** SQLite (tg_parsing_tasks, tg_audiences, tg_audience_members), Telethon, Celery+Redis

---

### Фича: TG Service — DM-кампании

- **Что делает:** Массовая рассылка личных сообщений. Шаблоны с вариантами (A/B спиннинг). Стратегии распределения: ROUND_ROBIN, GEO_MATCHED, RANDOM. AI-персонализация (Claude). Ramp-up для anti-ban. Трекинг ответов.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/dm_campaigns.py` — 10 endpoints
  - `tools/tg-service/app/tasks/dm_campaign_tasks.py` — send_dm_batch
- **От чего зависит:** SQLite (tg_dm_campaigns, tg_dm_messages, tg_message_templates, tg_template_variants), Telethon, Anthropic SDK, Celery

---

### Фича: TG Service — Chat Broadcasts

- **Что делает:** Публикация сообщений в несколько чатов/каналов. Отслеживание реакций, удалений, банов.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/chat_broadcasts.py` — 8 endpoints
  - `tools/tg-service/app/tasks/chat_broadcast_tasks.py` — broadcast_batch
- **От чего зависит:** SQLite (tg_chat_broadcasts, tg_chat_broadcast_posts), Telethon, Celery

---

### Фича: TG Service — Invite-кампании

- **Что делает:** Приглашение пользователей в каналы/группы. Режимы: DIRECT (add user) или INVITE_LINK. Трекинг результатов (SUCCESS, PRIVACY_RESTRICTED, ALREADY_PARTICIPANT, PEER_FLOOD).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/invite_campaigns.py` — 8 endpoints
  - `tools/tg-service/app/tasks/invite_campaign_tasks.py` — invite_batch
- **От чего зависит:** SQLite (tg_invite_campaigns, tg_invite_attempts), Telethon, Celery

---

### Фича: TG Service — AI Promoter (автономный агент в чатах)

- **Что делает:** AI-персоны с стратегиями (soft/medium/aggressive). Мониторинг целевых каналов. Генерация контекстных ответов (с RAG из базы знаний). Очередь одобрения (pending → approved → sent). Инициация DM из чатов.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/ai_promoter.py` — 12 endpoints
  - `tools/tg-service/app/tasks/ai_promoter_tasks.py` — monitor_channels, post_reply
- **От чего зависит:** SQLite (tg_ai_personas, tg_ai_messages, tg_kb_documents, tg_kb_chunks), Telethon, Anthropic SDK, embeddings, Celery

---

### Фича: TG Service — AI Sales Bot (автономные продажи)

- **Что делает:** Sales-скрипты с этапами. Автоматическая классификация лидов (NEW → ENGAGING → QUALIFIED → PROPOSAL → CONVERTED / LOST / HANDED_OFF). AI-ответы с учетом контекста. Передача человеку (handoff).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/ai_sales.py` — 12 endpoints
  - `tools/tg-service/app/tasks/ai_sales_tasks.py` — monitor_leads, send_sales_reply
- **От чего зависит:** SQLite (tg_sales_scripts, tg_sales_dialogs, tg_sales_messages), Telethon, Anthropic SDK, Celery

---

### Фича: TG Service — Комментирование

- **Что делает:** Автоматические комментарии в каналах. Режимы: AI, TEMPLATES, MIXED. Триггеры: ALL_POSTS, KEYWORDS, MANUAL. Workflow одобрения.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/commenting.py` — 6 endpoints
  - `tools/tg-service/app/tasks/commenting_tasks.py` — comment_batch
- **От чего зависит:** SQLite (tg_commenting_tasks, tg_commenting_log), Telethon, Anthropic SDK, Celery

---

### Фича: TG Service — Авто-ответчик

- **Что делает:** Автоматические ответы на входящие DM. Правила-сценарии с триггерами. 5 поведений: AI_REPLY, TEMPLATE, SILENCE, NOTIFY, HANDOFF_SALES. Задержка (jitter). Активные часы.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/auto_replier.py` — 7 endpoints
  - `tools/tg-service/app/tasks/auto_replier_tasks.py` — monitor_dialogs
- **От чего зависит:** SQLite (tg_auto_replier_scenarios, tg_auto_replies), Telethon, Anthropic SDK, Celery

---

### Фича: TG Service — Warmup аккаунтов

- **Что делает:** Прогрев аккаунтов для anti-ban. 6 типов действий: READ_CHATS, REACT_POST, SHORT_REPLY, SUBSCRIBE_CHANNEL, UPDATE_PROFILE, POST_STORY. Скрипты с последовательностями действий. Уровни прогрева: FRESH → BEGINNER → ACTIVE → EXPERIENCED (0-100).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/warmup.py` — 4 endpoints (status, start, stop, log)
  - `tools/tg-service/app/api/v1/warmup_scripts.py` — 8 endpoints (CRUD scripts + run/history)
  - `tools/tg-service/app/tasks/warmup_tasks.py`, `warmup_script_tasks.py`
- **От чего зависит:** SQLite (tg_warmup_actions, tg_warmup_scripts, tg_warmup_runs), Telethon, Celery

---

### Фича: TG Service — Boost (накрутка)

- **Что делает:** 4 типа: SUBSCRIBERS, REACTIONS, VIEWS, POLL_VOTES. Natural curve distribution. Boost историй (AUTO_MONITOR / MANUAL mode).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/boost.py` — 7 endpoints
  - `tools/tg-service/app/api/v1/stories_boost.py` — 5 endpoints
  - `tools/tg-service/app/tasks/stage5_tasks.py`
- **От чего зависит:** SQLite (tg_boost_tasks, tg_boost_actions, tg_stories_boost_tasks), Telethon, Celery

---

### Фича: TG Service — Инструменты каналов

- **Что делает:** Клонирование каналов (посты, профиль, аватар, закреп; опционально AI-рерайт). Создание каналов/групп (CHANNEL, SUPERGROUP, BASIC_GROUP; naming patterns). Конвертация сессий (TDATA ↔ SESSION ↔ SESSION_JSON). Join в чаты (с интервалами).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/cloner.py` — 5 endpoints
  - `tools/tg-service/app/api/v1/channel_creator.py` — 5 endpoints
  - `tools/tg-service/app/api/v1/converter.py` — 4 endpoints
  - `tools/tg-service/app/api/v1/join_chats.py` — 5 endpoints
  - `tools/tg-service/app/api/v1/channels.py` — 6 endpoints (CRUD каналов, resolve по username/link)
- **От чего зависит:** SQLite (tg_clone_tasks, tg_channel_creation_tasks, tg_conversion_tasks, tg_join_tasks, tg_channels), Telethon, Celery

---

### Фича: TG Service — Прямой Telegram-клиент

- **Что делает:** Просмотр диалогов, чтение сообщений, отправка сообщений, пометка прочитанным — напрямую через Telethon.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/telegram_client.py` — 5 endpoints (dialogs, messages, send, mark-read, sessions)
- **От чего зависит:** Telethon, AES-256-GCM (сессии)

---

### Фича: TG Service — Knowledge Base (RAG)

- **Что делает:** Документы для контекста AI-агентов. Автоматический chunking + embedding (локально). Семантический поиск. Используется AI Promoter и Sales Bot.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/knowledge_base.py` — 7 endpoints (CRUD + rechunk + search + stats)
- **От чего зависит:** SQLite (tg_kb_documents, tg_kb_chunks), sentence-transformers/fastembed

---

### Фича: TG Service — Проверка телефонов

- **Что делает:** Batch-проверка номеров через Telegram API. Результат: найден/нет, user_id, username, is_premium.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/phone_checker.py` — 3 endpoints (list batches, check, get results)
- **От чего зависит:** SQLite (tg_phone_checks, tg_phone_check_results), Telethon

---

### Фича: TG Service — Шаблоны сообщений

- **Что делает:** CRUD шаблонов с вариантами (A/B спиннинг). Используются в DM-кампаниях, комментировании, авто-ответчике.
- **Точки входа:**
  - `tools/tg-service/app/api/v1/templates.py` — 7 endpoints (CRUD шаблонов + CRUD вариантов)
- **От чего зависит:** SQLite (tg_message_templates, tg_template_variants)

---

### Фича: TG Service — Настройки

- **Что делает:** Глобальные настройки workspace TG Service (GET + PATCH).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/settings.py` — 2 endpoints
- **От чего зависит:** SQLite (tg_settings)

---

### Фича: TG Service — Дашборд и мониторинг

- **Что делает:** Сводная статистика по аккаунтам, кампаниям, задачам. Healthcheck (DB, AI).
- **Точки входа:**
  - `tools/tg-service/app/api/v1/dashboard.py` — 1 endpoint (stats)
  - `tools/tg-service/app/api/v1/smoke.py` — 3 endpoints (health, smoke/db, smoke/ai-test)
- **От чего зависит:** SQLite, Anthropic SDK (ai-test)

---

### Фича: Деплой и мониторинг

- **Что делает:** GitHub webhook → deploy.sh → Telegram уведомления с прогресс-баром. Health endpoint. 502 → maintenance page (auto-refresh 10s). Graceful shutdown (SIGTERM).
- **Точки входа:**
  - `app/api/health/route.ts` — GET
  - `app/api/deploy/webhook/route.ts` — POST
  - `app/api/dashboard/route.ts` — GET
  - `lib/services/telegram/deploy.ts`
  - Экран: `/dashboard`
- **От чего зависит:** Prisma (DeployMessage), Telegram Bot API, GitHub webhooks, PM2, nginx

---

## Модули / слои

### PUP — Next.js App

| Слой       | Расположение                          | Ответственность                                               |
| ---------- | ------------------------------------- | ------------------------------------------------------------- |
| API Routes | `app/api/`                            | HTTP endpoints, валидация, авторизация, вызов сервисов        |
| Pages      | `app/(authenticated)/`, `app/(auth)/` | React SSR/CSR страницы                                        |
| Services   | `lib/services/`                       | Бизнес-логика, работа с БД, внешние API                       |
| Middleware | `middleware.ts`, `lib/middleware/`    | Rate limiting, CORS, auth resolution, scope enforcement       |
| Components | `components/`                         | UI компоненты (board, chat, kb, layout, notifications, users) |
| Schemas    | `lib/schemas/`                        | Zod-валидация                                                 |
| Constants  | `lib/constants/`                      | Перечисления, конфиги                                         |
| Types      | `types/`                              | TypeScript типы                                               |
| DB         | `prisma/schema.prisma`                | Prisma ORM (74 модели)                                        |

### YT Parser — Express App

| Слой     | Расположение                | Ответственность                                                                                   |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| Routes   | `tools/yt-parser/routes/`   | HTTP endpoints (leads, projects, agent, settings, knowledge, etc.)                                |
| Services | `tools/yt-parser/services/` | AI (pitch gen), email (Resend+IMAP), outreach-worker, Telegram, knowledge (RAG), scoring, crawler |
| DB       | `tools/yt-parser/db/`       | SQLite per-workspace, schema, migrations, lead-importer, api-keys                                 |
| Scripts  | `tools/yt-parser/scripts/`  | Bulk enrich, reparse, refresh summary                                                             |
| UI       | `tools/yt-parser/public/`   | SPA dashboard (HTML+JS)                                                                           |
| Utils    | `tools/yt-parser/utils/`    | Auth, helpers                                                                                     |

### TG Service — FastAPI App

| Слой     | Расположение                         | Ответственность                                                          |
| -------- | ------------------------------------ | ------------------------------------------------------------------------ |
| API      | `tools/tg-service/app/api/v1/`       | FastAPI routers (28 файлов, ~187 endpoints)                              |
| Tasks    | `tools/tg-service/app/tasks/`        | Celery задачи (17+ модулей)                                              |
| AI       | `tools/tg-service/app/ai/`           | Anthropic Claude client (generate_message, cost tracking)                |
| Core     | `tools/tg-service/app/core/`         | Database (per-workspace SQLite), security (AES-256-GCM), logging, errors |
| Telegram | `tools/tg-service/app/telegram/`     | Telethon client pool, session management                                 |
| Services | `tools/tg-service/app/services/`     | Бизнес-логика                                                            |
| Config   | `tools/tg-service/app/config.py`     | Pydantic settings, env vars                                              |
| Schema   | `tools/tg-service/schema.sql`        | 40+ таблиц, 820 строк                                                    |
| UI       | `tools/tg-service/public/index.html` | SPA dashboard (single HTML)                                              |

---

## Внешние интеграции

| Сервис                  | Протокол       | Где используется                                                                                | Назначение                                                        |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Anthropic Claude**    | REST API       | PUP (agent, marketing, voice summary), YT Parser (ai.js), TG Service (anthropic_client.py)      | Генерация pitch/reply, скоринг, суммаризация, sales bot, promoter |
| **Groq Whisper**        | REST API       | PUP (`app/api/transcribe`, `voice/.../recording`)                                               | Транскрипция аудио (whisper-large-v3, русский)                    |
| **YouTube Data API v3** | REST API       | PUP (`lib/services/marketing/mkt-parser.service.ts`), YT Parser (`services/ai.js`, `server.js`) | Поиск каналов, метаданные, видео, комментарии                     |
| **Resend**              | REST API       | PUP (`lib/services/marketing/mkt-email.service.ts`), YT Parser (`services/email.js`)            | Отправка email (SPF/DKIM/DMARC)                                   |
| **IMAP (Hostinger)**    | IMAP4          | PUP (mkt-email.service), YT Parser (email.js)                                                   | Чтение входящих писем (inbox polling)                             |
| **Telegram Bot API**    | REST API       | PUP (`lib/services/telegram/sender.ts`, `bot.ts`)                                               | Admin-уведомления, deploy progress                                |
| **Telegram MTProto**    | MTProto        | YT Parser (`services/telegram-outreach.js`, gramjs), TG Service (Telethon)                      | User-bot: DM, парсинг, кампании, sales                            |
| **Metered.ca TURN**     | STUN/TURN      | PUP (`app/api/voice/ice-servers`)                                                               | WebRTC relay для voice channels                                   |
| **Proxy Seller API**    | REST API       | TG Service (`app/api/v1/proxy_seller.py`)                                                       | Покупка/импорт прокси, баланс                                     |
| **External Users API**  | REST API       | PUP (`app/api/workspaces/[id]/external-users/proxy`)                                            | Проксирование к стороннему проекту (scroogefinance.online)        |
| **GitHub Webhooks**     | REST (inbound) | PUP (`app/api/deploy/webhook`)                                                                  | Авто-деплой по push                                               |

---

## Уточнения (из обсуждения с владельцем)

### Telegram-бот

Один бот на всю платформу: **@controler_panel_bot**. Это лицо веб-интерфейса. Сейчас выполняет базовые уведомления, будет расширяться позже. TG Service использует Telethon (user-боты) для массовых операций — это другой слой.

### YT Parser vs PUP Marketing

**YT Parser — единственный рабочий инструмент** для outreach pipeline. PUP Marketing (`lib/services/marketing/`, `app/api/workspaces/[id]/marketing/`) — deprecated, подлежит удалению. При клике на "Маркетинг" в сайдбаре должно открываться окно выбора модуля (карточки: YT Parser, TG Service, и т.д.), а не текущий Marketing UI.

### TG Service — Audiences

Аудитории (tg_audiences, tg_audience_members) — результат работы парсера. Парсинг создаёт аудиторию автоматически. Управление идёт через parser endpoints.

### TG Service — Phone Checker

Реализован: `phone_checker.py` (3 endpoints), таблицы tg_phone_checks + tg_phone_check_results в schema.sql.

### Vector search в PUP KB

Отложено на неопределённый срок. Поля embedding зарезервированы. Текущий поиск — полнотекстовый. В YT Parser и TG Service embeddings работают через локальные модели (@xenova/transformers, sentence-transformers).

### Модуль Users — внешний API

Универсальный коннектор. Каждый workspace подключает свой внешний API (apiEndpoint + apiKey) для отображения пользователей своего продукта. Не привязан к одному проекту.

### Модуль Analytics — внешний redirect

Аналогичная модулю Users логика: каждый workspace подключает внешний URL аналитики (`externalAnalyticsUrl`). Сейчас временный redirect настроен только в workspace Ananas. Voice channels — отдельная функциональность, не связана с модулем analytics, несмотря на совпадение URL path `/workspaces/[id]/analytics`.

---

## Review log

| Дата       | Что проверялось                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Итог                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 2026-05-23 | Независимый аудит: Explore-агент сопоставил все секции FUNCTIONAL_MAP.md с фактическим кодом (API routes, services, middleware, Prisma-модели, TG Service routers, YT Parser endpoints, schema.sql). Найдено и исправлено: +12 PUP API routes, +10 YT Parser routes, +5 TG Service routers (channels, templates, settings, dashboard, smoke), +5 PUP services/middleware, Prisma 50+ → 74 модели, TG Service 27 → 28 файлов, убраны пометки «статус неизвестен» (phone_checker, audiences подтверждены), добавлены пропущенные Prisma-модели GlobalChatAttachment/GlobalChatReaction в Chat. | ✅ соответствует коду на дату 2026-05-23 |
