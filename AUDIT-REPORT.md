# ПОЛНЫЙ АУДИТ ПРОЕКТА ПУП

**Дата:** 2026-05-21
**Агенты:** 12 (Security, Code Review, Backend Architect, Database, Performance, SRE, DevOps, Accessibility, UI Design, Documentation, Software Architect, Frontend)
**Найдено проблем:** ~200+

---

## СВОДКА ПО SEVERITY

| Приоритет      | Кол-во | Описание                                     |
| -------------- | ------ | -------------------------------------------- |
| P0 НЕМЕДЛЕННО  | 8      | Активные уязвимости, потеря данных           |
| P1 КРИТИЧЕСКИЕ | 15     | Утечки между тенантами, RCE, XSS             |
| P2 ВЫСОКИЕ     | 25     | Производительность, логика, надёжность       |
| P3 СРЕДНИЕ     | 40+    | Accessibility, UI, документация, архитектура |
| P4 НИЗКИЕ      | 30+    | Code quality, мелкие улучшения               |

---

## P0 -- НЕМЕДЛЕННО (сегодня)

### SEC-01: AUTH_SECRET = дефолтный placeholder

- **Файл:** `.env` -- `AUTH_SECRET="your-secret-here-change-in-production"`
- **Риск:** Любой может подделать JWT-токен NextAuth
- **Фикс:** `openssl rand -base64 32` -> новый AUTH_SECRET + CHAT_JWT_SECRET (пустой!)
- **Также:** Ротировать все API-ключи (Anthropic, Telegram, Groq, YouTube, Metered, GitHub)

### SEC-02: Deploy webhook без аутентификации

- **Файл:** `app/api/deploy/webhook/route.ts:15`
- **Риск:** `if (secret)` -- если GITHUB_WEBHOOK_SECRET не задан, exec("/var/www/deploy.sh") вызывается без проверки
- **Фикс:** `if (!secret) return NextResponse.json({error:"Not configured"}, {status:503})`

### SEC-03: SSRF через External Users Proxy

- **Файл:** `app/api/workspaces/[id]/external-users/proxy/route.ts:36-47`
- **Риск:** apiEndpoint можно настроить на http://169.254.169.254 (cloud metadata)
- **Фикс:** Добавить `validateExternalUrl(targetUrl)` перед fetch

### SEC-04: XSS через dangerouslySetInnerHTML (Dashboard)

- **Файл:** `dashboard/dashboard-client.tsx:205-210`
- **Риск:** URL из чат-сообщений вставляется в HTML без экранирования
- **Фикс:** DOMPurify.sanitize() или escapeHtml() для URL

### SEC-05: XSS через DOCX preview (Knowledge Base)

- **Файл:** `knowledge/knowledge-client.tsx:584`
- **Риск:** HTML из DOCX рендерится через dangerouslySetInnerHTML
- **Фикс:** DOMPurify.sanitize(data.content)

### SRE-01: Нет бэкапов PostgreSQL

- **Риск:** Потеря всех данных при сбое диска
- **Фикс:** Cron pg_dump каждую ночь + копия на внешнее хранилище

### SRE-02: Нет /api/health endpoint

- **Риск:** Невозможно автоматически проверить живучесть приложения
- **Фикс:** Создать endpoint с проверкой Prisma + основных таблиц

### PERF-01: ChatNotifications поллит каждые 5 сек НА КАЖДОЙ СТРАНИЦЕ

- **Файл:** `components/notifications/ChatNotifications.tsx:25`
- **Риск:** 12 req/min/tab фоновой нагрузки (даже на CRM-доске, настройках и т.д.)
- **Фикс:** Увеличить POLL_INTERVAL с 5000 до 30000 (одна строка)

---

## P1 -- КРИТИЧЕСКИЕ (эта неделя)

### SEC-06: Нет проверки membership в Marketing API routes

- **Файлы:** marketing/config, worker, pending, leads, dialogues, deals, projects
- **Риск:** Любой авторизованный пользователь может читать/менять данные чужого workspace
- **Фикс:** Добавить checkMembership() во все marketing routes

### SEC-07: Mass Assignment в marketing config

- **Файл:** `app/api/workspaces/[id]/marketing/config/route.ts:41`
- **Риск:** `data: body` без фильтрации -> перезапись любых полей (API ключи, workspaceId)
- **Фикс:** Whitelist разрешённых полей через Zod-схему

### SEC-08: ICE Servers endpoint без auth

- **Файл:** `app/api/voice/ice-servers/route.ts`
- **Риск:** TURN-креденшалы доступны без аутентификации -> финансовый ущерб
- **Фикс:** Добавить auth() проверку

### SEC-09: Security headers отсутствуют

- **Файл:** `next.config.mjs`
- **Фикс:** Добавить CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy

### ARCH-01: Inbox матчинг лидов без workspaceId

- **Файл:** `mkt-worker.service.ts:593-601`
- **Риск:** MktLeadEmail ищется без фильтра workspaceId -> ответ блогера попадает в чужой workspace
- **Фикс:** Добавить `lead: { workspaceId }` в where-clause

### ARCH-02: Worker -- singleton на весь процесс

- **Файл:** `mkt-worker.service.ts:80-96`
- **Риск:** Только один workspace может обрабатываться. stop() убивает worker любого workspace.
- **Фикс:** Map<workspaceId, WorkerState> вместо глобальных переменных

### ARCH-03: Worker start() не awaited

- **Файл:** `app/api/workspaces/[id]/marketing/worker/route.ts:32`
- **Риск:** Ошибки теряются (unhandled rejection), статус возвращается до реального запуска
- **Фикс:** await start(workspaceId)

### DB-01: Dashboard N+1 (65+ SQL-запросов на загрузку)

- **Файл:** `app/api/dashboard/route.ts:23-75`
- **Фикс:** Агрегировать через groupBy вместо цикла

### DB-02: 9 столбцов без индексов

- User.lastSeenAt, Task.createdById, Comment.authorId, Attachment.uploadedById, VoiceParticipant.userId, ColumnMoveLog.movedByUserId, MktLead.email, Notification.[recipientId,createdAt]
- **Фикс:** Добавить @@index в Prisma schema + миграция

### DB-03: Unbounded getWorkspaceById (все задачи без лимита)

- **Файл:** `workspace.service.ts:232-260`
- **Риск:** 500 задач = мегабайты JSON, поллится каждые 5 сек
- **Фикс:** Пагинация задач, убрать timeIntervals из списка

### DEVOPS-01: Нет CI/CD (GitHub Actions)

- **Риск:** Сломанный код деплоится без проверки
- **Фикс:** .github/workflows/ci.yml с typecheck + lint + test + build

### DEVOPS-02: 26 уязвимостей в зависимостях (1 critical)

- Critical: form-data < 2.5.4 (через node-telegram-bot-api)
- High: xlsx@0.18.5 (abandoned), Next.js HTTP deserialization
- **Фикс:** Заменить xlsx, обновить telegram-bot-api

### PERF-02: AudioContext leak (уведомления + WebRTC)

- **Файлы:** ChatNotifications.tsx:31, use-webrtc.ts:155
- **Риск:** Создаётся при каждом уведомлении/track, не закрывается. Лимит браузера ~6.
- **Фикс:** Переиспользовать один AudioContext

### FE-01: useState вместо useEffect в CategoryDialog

- **Файл:** knowledge-client.tsx:288-291
- **Риск:** Список категорий не обновляется после создания новой
- **Фикс:** Заменить на useEffect

### SRE-03: Deploy запускается из самого приложения, которое он убивает

- **Файл:** deploy/webhook/route.ts:67
- **Риск:** exec("/var/www/deploy.sh") -> deploy.sh убивает PM2 pup -> callback никогда не вызовется
- **Фикс:** Отдельный webhook-сервер или GitHub Actions

---

## P2 -- ВЫСОКИЕ (следующая неделя)

### PERF-03: Chat поллинг ~76 req/min/tab

- 4 параллельных поллера: channels(5s), messages(2s), typing(2s), online(15s)
- **Фикс:** SSE (Server-Sent Events) вместо polling. Один канал на соединение.

### PERF-04: CRM-доска поллит каждые 5 сек (200KB payload)

- **Файл:** workspace-board-shell.tsx:28
- **Фикс:** ETag/If-Modified-Since, увеличить интервал до 15s

### PERF-05: Нет dynamic imports во всём проекте

- 0 вызовов next/dynamic или React.lazy
- **Фикс:** Lazy load dnd-kit, react-markdown, VoiceRecorder, md-editor

### PERF-06: marketing-client.tsx -- 3536 строк в одном файле

- **Фикс:** Разбить на 6 секций + dynamic import

### PERF-07: chat-client.tsx -- 25 useState, full tree re-render

- **Фикс:** Разбить на ChatSidebar, ChatMessages, ChatInput, ChatDialogs

### ARCH-04: SLA пересчитывается от createdAt вместо now()

- **Файл:** ticket.service.ts:424-427
- **Риск:** Повышение приоритета сразу делает тикет "просроченным"
- **Фикс:** calcSlaDeadline(data.priority, new Date())

### ARCH-05: Ticket number race condition

- **Файл:** ticket.service.ts:322-384 и email.service.ts:197-204
- **Риск:** Дублирование номеров при параллельных запросах (email.service без транзакции)
- **Фикс:** DB sequence или единая генерация через $transaction

### ARCH-06: ADMIN role обходит все workspace checks

- **Риск:** Любой ADMIN видит все workspace всех организаций
- **Фикс:** ADMIN bypass только для /admin/\* routes

### ARCH-07: Worker lock 5 мин слишком короткий для AI-генерации

- **Файл:** mkt-worker.service.ts:33
- **Риск:** При timeout Claude API -- дубликат отправки письма
- **Фикс:** Увеличить до 15 мин + проверка существующего MktDialogue перед отправкой

### ARCH-08: Pending reply approve без idempotency guard

- **Риск:** Двойной клик -> двойная отправка письма
- **Фикс:** Проверить status === 'PENDING' перед approve

### DB-04: N+1 в listChannels (count на каждый канал)

- **Файл:** channel.service.ts:146-173
- **Фикс:** Один raw SQL с GROUP BY channelId

### DB-05: Отсутствие транзакций (6 мест)

- deleteAttachment, createManualLead, sendMessage, addMessage+status transition, и др.
- **Фикс:** Обернуть в db.$transaction

### FE-02: Auto-scroll ломает чтение истории в global-chat

- **Файл:** global-chat-client.tsx:128-141
- **Фикс:** Добавить проверку isNearBottom (как в workspace-чате)

### FE-03: URL.createObjectURL leak в global-chat

- **Файл:** global-chat-client.tsx:781
- **Фикс:** Компонент FilePreviewImg с revokeObjectURL в useEffect

### FE-04: Dark mode сломан в ~50 местах

- Жёсткие text-gray-700, bg-white, text-white в chat, voice, dashboard
- **Фикс:** Заменить на text-foreground, bg-card, text-muted-foreground

### FE-05: Stale selection тикетов при смене фильтра

- **Файл:** tickets-client.tsx
- **Фикс:** Добавить setSelected(new Set()) при смене фильтра

### SRE-04: Нет graceful shutdown (SIGTERM)

- **Риск:** При deploy: активные запросы обрываются, worker не останавливается, Prisma не disconnect
- **Фикс:** process.on('SIGTERM', ...) в instrumentation.ts

### SRE-05: Нет env-валидации при старте

- **Риск:** Приложение стартует с пустыми/placeholder секретами
- **Фикс:** Zod-схема для process.env

### CODE-01: tool_use_id дублируется (Math.random вызывается дважды)

- **Файл:** mkt-ai.service.ts:925-943
- **Риск:** Claude API ошибка при несовпадении ID
- **Фикс:** Вычислить ID один раз в переменную

### CODE-02: Crawler ссылается на конструктор Error вместо пойманной ошибки

- **Файл:** crawler.service.ts:298-301
- **Фикс:** `catch (err)` вместо `catch {}`

### CODE-03: runLeadNow `|| true` -- dead code

- **Файл:** mkt-worker.service.ts:1778
- **Фикс:** Убрать `|| true` или удалить dead code после if

---

## P3 -- СРЕДНИЕ (2-3 недели)

### Accessibility (7 критических WCAG-нарушений)

- Kanban: div onClick вместо button (TaskCard.tsx:90)
- DnD: нет KeyboardSensor (Board.tsx:66)
- Нет aria-live для уведомлений, чата, ошибок (0 aria-live в проекте)
- Voice модалки: нет focus trap, нет Escape, нет role="dialog"
- Нет skip-link навигации (AppShell)
- Drag handles без aria-label
- 30+ иконочных кнопок без accessible name

### Accessibility (12 серьёзных)

- nav без aria-label, inputs без label, ошибки форм без aria-describedby
- confirm() вместо AlertDialog, hardcoded цвета нарушают контраст

### Architecture

- workspace.service.ts -- God Object (827 строк, 4 bounded context)
- Дублирование паттерна авторизации (~50 раз)
- Нет auth middleware (72 повторения session check)
- "copy 2/3" мусорные директории (~30 штук)
- Prisma schema монолит (1946 строк, 50+ моделей)
- Секреты в plaintext в БД (MktConfig API keys)

### Database

- Connection pool не настроен (default 3 на 1 CPU)
- Soft/hard delete неконсистентен
- JSON в строках вместо native типов
- cleanupOldLogs без батчинга
- Bulk delete тикетов -- orphaned файлы

### UI Design System

- Публичный чат полностью без dark mode (80+ мест)
- 12+ произвольных размеров шрифтов (text-[7px] до text-[22px])
- 5 стилей Form Labels
- Нет единого EmptyState компонента
- Неконсистентные Loading States (3 модуля без скелетонов)
- Дублированные цвета приоритетов (LOW = синий/серый/серый в разных модулях)

### Documentation

- README.md = заглушка create-next-app
- 7 из 8 модулей без документации
- DEPLOY.md полностью отсутствует (bus factor = 1)
- .env.example неполный (нет Marketing/IMAP/Groq/TURN переменных)
- Нет CHANGELOG, нет CONTRIBUTING.md
- CRM API docs устарели ("projects" вместо "workspaces")

### Other

- CORS wildcard (\*) на chat API
- frame-ancestors \* для embed (clickjacking)
- Логирование логинов в auth.ts
- Rate limiting только для public chat
- Слабая валидация пароля (min 6)
- DNS rebinding TOCTOU
- Prompt injection через данные YouTube-каналов
- IMAP соединение создаётся заново при каждом markSeen
- Нет prefers-reduced-motion в CSS
- Notification click ведёт на dashboard вместо задачи
- Online indicator показывает всех как онлайн
- Volume slider не работает (voice)

---

## P4 -- НИЗКИЕ

- Дублирование утилиты formatFileSize (3 варианта)
- Index as key в move history, pending files
- Нет barrel exports в services
- Избыточные индексы (email, login, ticketId уже unique)
- Heartbeat без debounce
- In-memory rate limiter не работает в cluster
- Нет whitelist MIME при upload
- Chat avatars endpoint без auth
- Dead code consultation_answer
- eslint-disable на весь файл (3 файла marketing)
- googleapis в dependencies но закомментирован
- Inline SVG вместо lucide (2 места)
- sr-only "Close" на английском
- Password show button с tabIndex={-1}
