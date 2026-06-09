# TG Multichannel Outreach — Фаза 1 (бэкенд)

Ветка: `feat/tg-multichannel-outreach`. НЕ мёржить в main, НЕ деплоить.
ТЗ: `../../TZ-telegram-outreach.md` (корень PUP). Тест-режим: `DRY_RUN=true`, проверка через curl/логику.

## Чек-лист шагов

- [x] **Шаг 1 — Схема БД**: таблица `tg_account` + `dialogues.account_id` (идемпотентно).
- [x] **Шаг 2 — Пул аккаунтов**: рефактор `telegram-outreach.js` из single → пул (Map), per-account login/status/logout, автологин всех active, `pickAccount()` round-robin по здоровью, `sendMessageVia()`, per-account listener (тег account_id). API для CRUD аккаунтов.
- [x] **Шаг 3 — Прокси (SOCKS5)**: билдер proxy-опции для TelegramClient из полей `tg_account`; заготовка под MTProxy (`proxy_type`).
- [x] **Шаг 4 — Анти-бан**: пейсинг-очередь TG с джиттером 30–90с; per-account дневной лимит + ramp-up по `first_used_at`; обработка `FloodWaitError` → `flood_until`.
- [x] **Шаг 5 — Выбор каналов**: `POST /api/leads/:id/run` принимает `channels[]`; доступность отдаётся в данных лида; рассылка по КАЖДОМУ выбранному каналу (своя запись dialogue+message, свой incrementDailyCount, account_id для TG); идемпотентность по каналу; ревью-режим — строка в pending_replies на канал.
- [x] **Шаг 6 — Входящие + approve под TG**: надёжный матч лида + тег account_id; approve шлёт через `sendMessageVia` тем же аккаунтом из `dialogues.account_id`.
- [x] **Шаг 7 — Проверка**: curl всех новых эндпоинтов при DRY_RUN, lint, рестарт dev-сервера, обновление этого файла.

## Проверка (шаг 7) — что прогнано при DRY_RUN

Все проверки — без реальных отправок (DRY_RUN=true) и без реальных аккаунтов
(тест-сим `__testInjectReady` делает аккаунт «готовым» без коннекта к Telegram).

- **Миграции**: применяются на существующей и пустой БД без ошибок (`tg_account`, `dialogues.account_id`).
- **Пул/прокси (API)**: создание 3 аккаунтов (SOCKS5 / MTProxy / без прокси), `status` показывает все; PATCH/DELETE/login/code — graceful (локально TG-креды в `.env` пустые → понятная ошибка).
- **Анти-бан (unit)**: пейсинг — первая отправка сразу, зазоры в окне джиттера; round-robin альтернирует A/B; flood-пауза → `pickAccount` пропускает → `recoverFlooded` возвращает; over-cap по ramp-up (день1=5) исключает аккаунт.
- **Мультиканал (DRY)**: лид email+telegram, channels=оба → 2 диалога + 2 сообщения, оба дневных счётчика +1, TG-диалог имеет `account_id`; идемпотентность по каналу (повтор не плодит).
- **Ревью-режим (DRY)**: по строке `pending_replies` на канал (email с subject, TG без); стадия `awaiting_review`; повтор не плодит (`hasPendingForChannel`).
- **Входящие + approve (DRY)**: входящее TG → запись + стадия `replied` (затем продвигается reply-генерацией, как в email) + строка в `pending_replies`; диалог тегируется `account_id` получателя; approve уходит **тем же аккаунтом-владельцем** диалога (A), не получателем (B); fresh-входящее без диалога → диалог создаётся с `account_id` получателя.
- **HTTP-смоук**: `GET /api/telegram/status` (с `pacing`), `accounts` CRUD, `GET /api/leads` отдаёт `channels_available`/`channels_sent`, `POST /leads/:id/run` и `/bulk-run` принимают и возвращают `channels[]`, воркер получает вызов.
- **Lint/синтаксис**: `node --check` зелёный по всем файлам; prettier (husky lint-staged) зелёный на каждом коммите. Репозиторный eslint — конфиг Next.js/TS (`no-require-imports`) — к CommonJS-инструменту `yt-parser` неприменим (в нём `require()` везде; 4 unused-var — пре-существующие, не из этой работы).

## Принятые дефолты

- `tg_account` хранится в БД **default workspace** (как и текущая `settings.telegram_session`); модуль `telegram-outreach.js` работает с default-БД. Миграция создаёт таблицу во всех ws-БД (безвредно).
- Прокси по умолчанию `proxy_type='socks5'`, формат входных данных `host:port:user:pass`. MTProxy — заготовка (ветка по `proxy_type`).
- Пейсинг-джиттер: env `TG_PACING_MIN_MS`/`TG_PACING_MAX_MS` (дефолт 30000/90000). Очередь общая для всех аккаунтов (gap между любыми TG-отправками).
- Ramp-up: день1=5, день2=10, … шаг +5/день до `daily_cap` (по `first_used_at`; если null — день1).
- Авто-очередь (`processOutreachQueue`) без явных каналов → шлёт по ВСЕМ доступным каналам лида (раньше слала только один). Идемпотентность — по каналу.
- Легаси-эндпоинты `/api/telegram/status|login|code|password|logout` сохранены (мапятся на первый аккаунт пула) до Фазы 2.
- Ramp-up настраивается env `TG_RAMP_DAY1` (дефолт 5) и `TG_RAMP_STEP` (дефолт 5).
- При логине/автологине без сессии и с реальной legacy-`settings.telegram_session` — одноразовая миграция в `tg_account` (чтобы не потерять уже залогиненный прод-аккаунт). Если legacy-сессии нет — миграция не срабатывает.
- На живой отправке у `tg_account` должен быть прокси: без прокси клиент создаётся, но в лог пишется предупреждение (для прод TG прокси обязателен).

## Новые/изменённые эндпоинты

- `GET  /api/telegram/accounts` — список со статусом (без секретов).
- `GET  /api/telegram/accounts/:id`
- `POST /api/telegram/accounts` — `{label,phone,api_id?,api_hash?,proxy_type?,proxy_host?,proxy_port?,proxy_user?,proxy_pass?,proxy_string?,daily_cap?}` (`proxy_string` = `host:port:user:pass`).
- `PATCH /api/telegram/accounts/:id` — прокси/лимит/статус/label (`proxy_string` тоже принимается).
- `DELETE /api/telegram/accounts/:id`
- `POST /api/telegram/accounts/:id/login|code|password|logout`
- `POST /api/leads/:id/run` и `POST /api/leads/bulk-run` — доп. поле `channels: ["email","telegram"]`.
- `GET  /api/leads` — у лида добавлены `channels_available {email,telegram}` и `channels_sent [...]`.

## Фаза 2 (UI) — `public/index.html` (vanilla-JS SPA)

Ветка та же `feat/tg-multichannel-outreach`. Аккаунты не подключены (нет кредов) —
UI строится и проверяется структурно; реальный логин — позже вместе.

- [x] **Шаг 1 — Попап-пикер каналов при «Запустить»**: модалка с кнопками каналов (зелёный=доступен по `channels_available`, красный/disabled=нет, ✓=уже отправлен по `channels_sent`); мультивыбор → `POST /api/leads/:id/run {channels}`; то же для bulk → `/api/leads/bulk-run {ids,channels}`; будущие каналы (WhatsApp…) — disabled.
- [x] **Шаг 2 — Управление TG-аккаунтами в Настройках**: список из `/api/telegram/accounts`, добавление (label/phone/proxy_string/daily_cap), поэтапный логин per-account (login→code→password), статус (active/flood/banned/disabled + sent_today/cap), logout/delete, PATCH прокси/лимита.
- [x] **Шаг 3 — Переключатель канала в чате**: вкладки Email/Telegram по `channels_sent`; пер-канальная история; индикатор канала и аккаунта (account_id) у TG.
- [ ] **Шаг 4 — Бейджи каналов в списке лидов**: existing контакт-иконки увязать с состоянием доступен/отправлено.
- [ ] **Шаг 5 — Проверка**: нет ошибок в консоли, fetch-вызовы по контрактам, рестарт dev-сервера, обновление PROGRESS.

## Осталось на живой тест (нужно от Бруно)

- 3 реальных TG-аккаунта (phone/code/2FA) + 3 прокси. **Уточнить тип прокси** (SOCKS5 уже готов; MTProxy — заготовка, нужно дореализовать при необходимости).
- API-креды: либо общий `TG_API_ID`/`TG_API_HASH` в `.env` (локально сейчас ПУСТЫЕ), либо per-account `api_id`/`api_hash` при создании аккаунта.
- Снятие `DRY_RUN` и реальная отправка на одном тестовом контакте (вместе, на живом тесте).
- Фаза 2 (UI): попап-пикер каналов, управление 3 аккаунтами/прокси, переключатель канала в чате.
