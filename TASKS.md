# TASKS — Тесты и ревизия кода

Атомарные задачи по покрытию тестами и аудиту кода.
Три процесса: PUP (Next.js/Vitest), TG Service (Python/pytest), YT Parser (Express/Vitest).

---

## Этап 1. Инфраструктура тестов

- [ ] **1.1 PUP: Prisma test DB + seed helpers**
      Настроить тестовую SQLite-базу через Prisma (`prisma/schema.test.prisma` или env override).
      Создать `tests/helpers/prisma.ts` — инициализация, миграции, очистка между тестами.
      Создать `tests/helpers/seed.ts` — фабрики: `createUser()`, `createWorkspace()`, `createMember()`.
      Файлы: `vitest.config.ts`, `tests/helpers/prisma.ts`, `tests/helpers/seed.ts`, `tests/setup.ts`
      Критерий: `pnpm test` проходит с пустым test suite, БД создается/очищается, seed-фабрики работают.

- [ ] **1.2 PUP: Mock-фабрики внешних сервисов**
      Создать моки для: Anthropic SDK (`tests/mocks/anthropic.ts`), Resend (`tests/mocks/resend.ts`),
      ImapFlow (`tests/mocks/imap.ts`), Groq Whisper (`tests/mocks/groq.ts`), Telegram Bot API (`tests/mocks/telegram-bot.ts`).
      Каждый мок — `vi.mock()` с типизированными возвратами.
      Файлы: `tests/mocks/*.ts`
      Критерий: моки импортируются без ошибок, типы совпадают с реальными SDK.

- [ ] **1.3 YT Parser: Vitest + SQLite тестовые фикстуры**
      Добавить vitest в `tools/yt-parser/package.json`. Создать `vitest.config.js`.
      Создать `tests/helpers/db.js` — in-memory SQLite с полной схемой из `db/database.js`.
      Создать `tests/helpers/mocks.js` — моки Anthropic, Resend, ImapFlow, YouTube Data API, gramjs.
      Файлы: `tools/yt-parser/vitest.config.js`, `tools/yt-parser/tests/helpers/db.js`, `tools/yt-parser/tests/helpers/mocks.js`
      Критерий: `cd tools/yt-parser && npx vitest run` проходит с пустым suite, тестовая БД создается.

- [ ] **1.4 TG Service: расширить фикстуры (Telethon, Anthropic, Celery)**
      Добавить в `tests/conftest.py`: mock Telethon client pool, mock Anthropic SDK (возврат фиксированных ответов),
      mock Celery (синхронный `task.apply()`), фикстуру `test_client` с override `get_db` на `test_db`.
      Файлы: `tools/tg-service/tests/conftest.py`, `tools/tg-service/tests/mocks/telethon_mock.py`, `tools/tg-service/tests/mocks/anthropic_mock.py`
      Критерий: `cd tools/tg-service && pytest` — существующие 17 тестов зеленые + моки импортируются.

- [ ] **1.5 PUP: Playwright setup для E2E**
      Установить `@playwright/test`. Создать `playwright.config.ts` (baseURL: localhost:3000, webServer: `pnpm dev`).
      Создать `e2e/helpers/auth.ts` — логин через API, сохранение storageState.
      Файлы: `playwright.config.ts`, `e2e/helpers/auth.ts`, `e2e/helpers/fixtures.ts`
      Критерий: `npx playwright test` запускает dev-сервер, открывает браузер, пустой suite проходит.

---

## Этап 2. Unit-тесты по модулям

### PUP (Next.js)

- [ ] **2.1 Auth + Service Accounts**
      Тесты для: `lib/services/auth.service.ts`, `lib/services/service-account.service.ts`,
      `lib/middleware/with-auth.ts`, `lib/middleware/resolve-auth.ts`, `lib/middleware/with-service-auth.ts`,
      `lib/services/auth/rate-limit.ts`, `lib/services/auth/service-account-rate-limit.ts`.
      Сценарии: успешный логин, неверный пароль, деактивированный пользователь (кэш 60s), expired JWT,
      создание service account, валидация scopes, IP whitelist, rate limit (превышение → 429).
      Файлы: `tests/unit/auth.test.ts`, `tests/unit/service-accounts.test.ts`, `tests/unit/middleware.test.ts`
      Критерий: тесты зеленые, покрытие auth-слоя >= 80%.

- [ ] **2.2 Workspaces + Members + Modules**
      Тесты для: `lib/services/workspace.service.ts`, `lib/services/member.service.ts`, `lib/services/column.service.ts`.
      Сценарии: создание workspace, добавление/удаление участника, переключение модулей,
      allowedModules с вложенными ключами (`marketing:parsers:youtube`), global ADMIN override,
      роли OWNER/MEMBER, activity tracking.
      Файлы: `tests/unit/workspace.test.ts`, `tests/unit/member.test.ts`, `tests/unit/column.test.ts`
      Критерий: тесты зеленые, покрытие 3 сервисов >= 80%.

- [ ] **2.3 CRM: задачи, колонки, таймер**
      Тесты для: `lib/services/task.service.ts`, `lib/services/column.service.ts`,
      `lib/services/comment.service.ts`, `lib/services/attachment.service.ts`, `lib/services/timer.service.ts`.
      Сценарии: CRUD задач, перемещение (position recalc), назначение исполнителей,
      метки, чеклисты, start/stop таймера, история перемещений (ColumnMoveLog).
      Файлы: `tests/unit/task.test.ts`, `tests/unit/timer.test.ts`, `tests/unit/comment.test.ts`
      Критерий: покрытие >= 80%.

- [ ] **2.4 Knowledge Base**
      Тесты для: `lib/services/kb/article.service.ts`, `lib/services/kb/search.service.ts`,
      `lib/services/kb/import.service.ts`, `lib/services/kb/crawler.service.ts`,
      `lib/services/kb/url-validator.ts`, `lib/services/kb/parsers/*.ts`.
      Сценарии: CRUD статей, версионирование, откат версий, полнотекстовый поиск,
      импорт PDF/DOCX/XLSX, SSRF-защита (private IP rejection), краулинг (maxPages/maxDepth лимиты).
      Файлы: `tests/unit/kb-article.test.ts`, `tests/unit/kb-import.test.ts`, `tests/unit/kb-search.test.ts`
      Критерий: покрытие KB-сервисов >= 80%. SSRF-тесты проверяют блокировку 127.0.0.1, 10.x, 192.168.x.

- [ ] **2.5 Tickets + AI Agent**
      Тесты для: `lib/services/tickets/ticket.service.ts`, `lib/services/tickets/sla-check.service.ts`,
      `lib/services/tickets/analytics.service.ts`, `lib/services/tickets/customer.service.ts`,
      `lib/services/agent/agent.service.ts`, `lib/services/tickets/canned-response.service.ts`.
      Сценарии: CRUD тикетов, SLA (breach detection), статусная машина (OPEN→CLOSED),
      AI-агент: prompt construction (system prompt + KB context + history), response parsing,
      handoffThreshold (< 0.7 → человеку), canned responses lookup.
      Файлы: `tests/unit/ticket.test.ts`, `tests/unit/agent.test.ts`, `tests/unit/sla.test.ts`
      Критерий: покрытие >= 80%. AI-тесты проверяют структуру промпта и парсинг ответа.

- [ ] **2.6 Chat + SSE + Notifications**
      Тесты для: `lib/services/chat-internal/channel.service.ts`, `lib/services/chat-internal/message.service.ts`,
      `lib/services/chat-internal/sse.service.ts`, `lib/services/notification.service.ts`,
      `lib/services/telegram/sender.ts`.
      Сценарии: создание каналов (GENERAL неудаляем), DM, сообщения (soft delete), треды, реакции,
      SSE event formatting, notifications (ASSIGNED, COMMENTED, MOVED), TG-отправка.
      Файлы: `tests/unit/chat.test.ts`, `tests/unit/sse.test.ts`, `tests/unit/notification.test.ts`
      Критерий: покрытие >= 80%.

- [ ] **2.7 Voice + Transcription + Crypto**
      Тесты для: `lib/services/voice-summary.service.ts`, `lib/services/crypto.service.ts`,
      `lib/services/storage/local.storage.ts`, `lib/services/action-tracker.ts`, `lib/services/logger.service.ts`.
      Сценарии: AES-256-GCM encrypt/decrypt roundtrip, пустые/большие payload,
      voice summary prompt construction (замоканный Claude), файловое хранилище (upload/download/delete),
      action tracking (запись, фильтрация).
      Файлы: `tests/unit/crypto.test.ts`, `tests/unit/voice-summary.test.ts`, `tests/unit/storage.test.ts`
      Критерий: покрытие >= 80%. Crypto-тесты — обязательно разные nonce.

### TG Service (Python)

- [ ] **2.8 TG: Accounts + Proxies + Security**
      Расширить существующие `test_security.py`, `test_database.py`.
      Добавить тесты: CRUD аккаунтов (insert/update/delete в test_db), статусная машина
      (IMPORTED→ACTIVE→SPAM_BLOCKED→DEAD), CRUD прокси, авто-назначение (geo_matching, equal_distribution),
      bulk import/export, device fingerprint validation.
      Файлы: `tools/tg-service/tests/unit/test_accounts.py`, `tools/tg-service/tests/unit/test_proxies.py`
      Критерий: покрытие accounts + proxies логики >= 75%.

- [ ] **2.9 TG: AI-агенты (Promoter, Sales, Auto-replier)**
      Тесты для prompt construction и response parsing в AI Promoter, AI Sales Bot, Auto-replier.
      Сценарии: формирование system prompt с RAG-контекстом, парсинг AI-ответа (confidence, handoff),
      sales pipeline (NEW→ENGAGING→QUALIFIED→CONVERTED), стратегии промоутера (soft/medium/aggressive),
      триггеры авто-ответчика (AI_REPLY, TEMPLATE, SILENCE, HANDOFF_SALES).
      Файлы: `tools/tg-service/tests/unit/test_ai_promoter.py`, `tests/unit/test_ai_sales.py`, `tests/unit/test_auto_replier.py`
      Критерий: промпты проверяются на структуру, парсинг — на все ветки.

- [ ] **2.10 TG: Parser + Audiences + Templates + KB**
      Тесты: создание parsing task (8 режимов), сохранение результатов в аудиторию,
      merge аудиторий, экспорт CSV/JSON, CRUD шаблонов с вариантами (A/B),
      KB: chunking, embedding mock, семантический поиск (mock embedding similarity).
      Файлы: `tools/tg-service/tests/unit/test_parser.py`, `tests/unit/test_templates.py`, `tests/unit/test_kb.py`
      Критерий: покрытие >= 75%.

### YT Parser (Express)

- [ ] **2.11 YT Parser: core services (AI, email, scoring, knowledge)**
      Тесты для: `services/ai.js` (pitch generation prompt, response parsing), `services/email.js` (send via Resend mock, IMAP poll mock),
      `services/lead-scoring.js` (scoring algorithm), `services/knowledge.js` (RAG: chunking, embedding, search),
      `services/enrichment.js` (data enrichment logic), `db/database.js` (schema init, migrations).
      Файлы: `tools/yt-parser/tests/unit/ai.test.js`, `tests/unit/email.test.js`, `tests/unit/scoring.test.js`, `tests/unit/knowledge.test.js`
      Критерий: покрытие core-сервисов >= 70%.

---

## Этап 3. Интеграционные тесты (API)

### PUP (Next.js)

- [ ] **3.1 PUP API: Auth flow**
      Интеграционные тесты через HTTP (vitest + fetch/undici к `app/api/`).
      Сценарии: POST /auth/callback/credentials (логин → JWT), повторный логин → тот же user,
      неверный пароль → 401, деактивированный → 403, rate limit → 429 после N попыток,
      service account: Bearer → 200, невалидный scope → 403, IP вне whitelist → 403.
      Файлы: `tests/integration/auth.test.ts`, `tests/integration/service-accounts.test.ts`
      Критерий: все happy-path + edge-case сценарии зеленые.

- [ ] **3.2 PUP API: Workspaces + Members + Modules**
      Сценарии: POST /workspaces (создание), GET /workspaces (список), PATCH (обновление),
      POST members (добавление), DELETE members, PATCH modules (вкл/выкл),
      GET my-modules (фильтрация по allowedModules), GET members-activity.
      Edge-cases: не-OWNER не может удалить workspace, global ADMIN может добавлять members.
      Файлы: `tests/integration/workspaces.test.ts`
      Критерий: CRUD + авторизация покрыты.

- [ ] **3.3 PUP API: CRM (columns, tasks, comments, position)**
      Сценарии: POST columns, POST tasks, PATCH task (update), POST position (drag-drop reorder),
      POST comments, POST checklist, POST attachments (file upload), DELETE cascade.
      Edge-cases: position recalculation, перемещение между колонками → ColumnMoveLog запись.
      Файлы: `tests/integration/crm.test.ts`
      Критерий: полный CRUD + drag-drop + history.

- [ ] **3.4 PUP API: KB + Tickets**
      KB: POST articles, GET search, POST import/file (PDF mock), POST import/url (SSRF block),
      GET history, POST restore version.
      Tickets: POST ticket, PATCH status (state machine), POST messages, POST assign,
      POST ai/suggest (замоканный Claude), GET analytics.
      Файлы: `tests/integration/kb.test.ts`, `tests/integration/tickets.test.ts`
      Критерий: CRUD + search + AI suggest + SLA.

- [ ] **3.5 PUP API: Chat (channels, messages, threads, reactions)**
      Сценарии: POST channel, POST message, GET messages (pagination), POST thread reply,
      POST reaction (add/remove), POST bookmark, POST forward, POST pin, POST mute, POST read mark,
      POST dm (создание DM-канала), GET events (SSE — проверить формат).
      Edge-cases: GENERAL канал не удаляется, soft delete, DM между двумя users → один канал.
      Файлы: `tests/integration/chat.test.ts`
      Критерий: все CRUD операции + SSE формат.

### TG Service (Python)

- [ ] **3.6 TG API: Accounts + Proxies (CRUD, bulk, check)**
      Расширить `tests/integration/test_api.py`.
      Сценарии: POST /accounts (create), GET /accounts (list+filters), PATCH, DELETE,
      POST bulk-import, POST bulk-check-telegram (mock Telethon → success/fail),
      POST check-spamblock (mock), GET stats.
      Proxies: POST (create), GET (list), POST check-all, POST auto-assign.
      Файлы: `tools/tg-service/tests/integration/test_accounts_api.py`, `tests/integration/test_proxies_api.py`
      Критерий: все CRUD + bulk операции с моками.

- [ ] **3.7 TG API: Campaigns (DM, broadcasts, invites, commenting)**
      Сценарии: CRUD DM-кампаний, start → mock Celery task dispatch, GET progress,
      CRUD broadcasts, invite campaigns (DIRECT/INVITE_LINK), commenting tasks (AI/TEMPLATES/MIXED).
      Edge-cases: кампания без аккаунтов → ошибка, ramp-up validation.
      Файлы: `tools/tg-service/tests/integration/test_campaigns_api.py`
      Критерий: CRUD + start/stop + edge-cases.

### YT Parser (Express)

- [ ] **3.8 YT Parser API: Parse + Leads + Projects + Agent**
      Тесты через supertest к Express-app.
      Сценарии: POST /api/parse (mock YouTube API → SSE progress), GET /api/results,
      POST /api/leads (promote), GET /api/leads (list+filters), PATCH lead (score),
      CRUD projects, POST /api/agent/start (mock worker), GET /api/agent/logs,
      GET /api/presets, GET /api/analytics.
      Edge-cases: auth (login required), rate limit, DRY_RUN mode.
      Файлы: `tools/yt-parser/tests/integration/api.test.js`
      Критерий: основные endpoints покрыты с моками внешних API.

---

## Этап 4. Ревизия на баги и мертвый код

> Каждая задача: статический аудит → фиксы в коде → запись в BUGS_FOUND.md.
> Deprecated Marketing (`lib/services/marketing/`, `app/api/workspaces/[id]/marketing/`) — исключен.

- [ ] **4.1 PUP: Auth + Middleware + Security**
      Аудит: `lib/middleware/with-auth.ts`, `resolve-auth.ts`, `with-service-auth.ts`,
      `lib/services/auth.service.ts`, `lib/services/crypto.service.ts`, `lib/services/auth/rate-limit.ts`.
      Искать: race conditions в кэше isActive, timing attacks, необработанные JWT-ошибки,
      незакрытые потоки, hardcoded secrets, отсутствие sanitization.
      Критерий: каждый найденный баг зафиксирован в BUGS_FOUND.md + исправлен в коде.

- [ ] **4.2 PUP: Workspaces + Members + Columns**
      Аудит: `lib/services/workspace.service.ts`, `member.service.ts`, `column.service.ts`,
      `lib/services/membership-check.ts` + все route-файлы `app/api/workspaces/`.
      Искать: утечки данных между workspaces, отсутствие проверки workspace ownership,
      N+1 запросы, неиспользуемые экспорты, мертвые ветки if/else.
      Критерий: фиксы + BUGS_FOUND.md.

- [ ] **4.3 PUP: CRM + KB + Tickets + Agent**
      Аудит: `lib/services/task.service.ts`, `timer.service.ts`, `comment.service.ts`,
      `attachment.service.ts`, `lib/services/kb/` (10 файлов), `lib/services/tickets/` (7 файлов),
      `lib/services/agent/agent.service.ts`.
      Искать: position calculation bugs (drag-drop), file upload без размерных лимитов,
      SQL injection в полнотекстовом поиске, prompt injection в AI-агенте, SLA calculation errors,
      мертвый код, неиспользуемые импорты.
      Критерий: фиксы + BUGS_FOUND.md.

- [ ] **4.4 PUP: Chat + Voice + Notifications + Storage**
      Аудит: `lib/services/chat-internal/` (3 файла), `lib/services/chat/` (7 файлов),
      `lib/services/notification.service.ts`, `lib/services/telegram/` (3 файла),
      `lib/services/voice-summary.service.ts`, `lib/services/storage/`, `lib/services/action-tracker.ts`.
      Искать: SSE memory leaks (незакрытые connections), race conditions в чате,
      XSS в сообщениях (проверить DOMPurify), notification fan-out bugs,
      Telegram bot error handling, голосовые: orphaned rooms (без heartbeat cleanup).
      Критерий: фиксы + BUGS_FOUND.md.

- [ ] **4.5 TG Service: Core + API routers**
      Аудит: `app/core/database.py`, `security.py`, `errors.py`, `logging.py`,
      `app/deps.py`, `app/main.py`, `app/config.py`,
      все 28 файлов `app/api/v1/`, `app/ai/anthropic_client.py`, `app/telegram/client_pool.py`.
      Искать: SQL injection (raw queries в SQLite), сессии Telethon не закрываются,
      незашифрованные данные в логах, отсутствие rate limiting на тяжелых endpoints,
      мертвые endpoints, ошибки в schema.sql (FK constraints, missing indexes),
      Celery tasks без retry/error handling, client pool leaks.
      Критерий: фиксы + BUGS_FOUND.md.

- [ ] **4.6 TG Service: Celery tasks**
      Аудит: все 15 файлов `app/tasks/` (кроме `__init__.py`, `celery_app.py`).
      Искать: tasks без `acks_late`, отсутствие `max_retries`, необработанные исключения
      (Telethon FloodWait, ConnectionError), гонки при concurrent доступе к SQLite,
      beat_schedule конфликты, мертвые задачи.
      Критерий: фиксы + BUGS_FOUND.md.

- [ ] **4.7 YT Parser: server + routes + services**
      Аудит: `server.js`, все 16 файлов `routes/`, все 11 файлов `services/`,
      `db/database.js`, `utils/auth.js`.
      Искать: callback hell / unhandled promise rejections, SQL injection (raw SQLite queries),
      email отправка без rate limit, IMAP connection leaks, YouTube API key rotation bugs,
      мертвые routes, error handling gaps, hardcoded values.
      Критерий: фиксы + BUGS_FOUND.md.

---

## Этап 5. E2E (Playwright)

- [ ] **5.1 E2E: Auth → Workspace → Module navigation**
      Сценарий: открыть /login → ввести credentials → попасть на /workspaces →
      выбрать workspace → увидеть sidebar с модулями → кликнуть каждый модуль → страница загружается.
      Edge-cases: невалидный логин → ошибка, деактивированный user → redirect на /login.
      Файлы: `e2e/auth-navigation.spec.ts`
      Критерий: тест стабильно зеленый в headless Chrome.

- [ ] **5.2 E2E: CRM — полный цикл kanban**
      Сценарий: создать колонку → создать задачу → заполнить поля (приоритет, срок, исполнитель) →
      добавить комментарий → перетащить задачу в другую колонку (drag-drop) →
      проверить историю перемещений → удалить задачу.
      Файлы: `e2e/crm-kanban.spec.ts`
      Критерий: тест стабильно зеленый, drag-drop работает.

- [ ] **5.3 E2E: Chat — отправка и получение сообщений**
      Сценарий: открыть чат → выбрать канал → написать сообщение → увидеть его в ленте →
      ответить в тред → поставить реакцию → закрепить сообщение.
      Файлы: `e2e/chat.spec.ts`
      Критерий: сообщения появляются без перезагрузки (SSE).

- [ ] **5.4 E2E: KB — создание и поиск статьи**
      Сценарий: перейти в Knowledge Base → создать категорию → создать статью (markdown) →
      сохранить → воспользоваться поиском → статья находится.
      Файлы: `e2e/knowledge-base.spec.ts`
      Критерий: поиск возвращает созданную статью.

- [ ] **5.5 E2E: Tickets — создание и обработка тикета**
      Сценарий: создать тикет → назначить агента → изменить статус (OPEN → IN_PROGRESS → RESOLVED) →
      проверить SLA-таймер → закрыть тикет.
      Файлы: `e2e/tickets.spec.ts`
      Критерий: статусная машина работает корректно через UI.

---

## Итого

| Этап              | Задач  | Фокус                                       |
| ----------------- | ------ | ------------------------------------------- |
| 1. Инфраструктура | 5      | Test runners, fixtures, mocks, Playwright   |
| 2. Unit-тесты     | 11     | Сервисы, бизнес-логика, AI prompt/parse     |
| 3. Интеграционные | 8      | API endpoints, happy-path + edge-cases      |
| 4. Ревизия кода   | 7      | Баги, мертвый код, security, error handling |
| 5. E2E            | 5      | Пользовательские сценарии в браузере        |
| **Всего**         | **36** |                                             |

### Порядок выполнения

```
Этап 1 (блокирует всё) → Этап 2 + Этап 4 (параллельно) → Этап 3 → Этап 5
```

Этап 4 (ревизия) можно делать параллельно с Этапом 2, потому что аудит не зависит от тестовой инфраструктуры.
