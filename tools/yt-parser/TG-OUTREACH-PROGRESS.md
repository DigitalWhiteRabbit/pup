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
- [x] **Шаг 4 — Бейджи каналов в списке лидов**: existing контакт-иконки увязать с состоянием доступен/отправлено.
- [x] **Шаг 5 — Проверка**: нет ошибок в консоли, fetch-вызовы по контрактам, рестарт dev-сервера, обновление PROGRESS.

## Фаза 3 (импорт Telethon-сессий)

Реальность онбординга: аккаунты покупаются как пакет Telethon-сессии (`.session`
SQLite + `.json` метаданные). yt-parser на GramJS (StringSession) — нужен импорт-
конвертер (вход по телефону/коду для таких аккаунтов не используем). Секреты
(auth_key/2FA/api_hash) не логируем и не отдаём в API.

- [x] **Шаг 1 — Утилита конвертации**: `services/telethon-import.js` —
      `telethonSessionToStringSession(path)` читает better-sqlite3 `sessions(dc_id,
server_address, port, auth_key[256])` → GramJS `StringSession` (setDC + AuthKey)
      → `save()`. Round-trip тест (`scripts/test-telethon-import.js`): dc/ip/port
      сохраняются, auth_key байт-в-байт, кривой ключ → ошибка. `tmp/` в .gitignore.
- [x] **Шаг 2 — Эндпоинт импорта**: `POST /api/telegram/accounts/import` (multipart).
- [x] **Шаг 3 — Параметры клиента из сессии** (device/systemVersion/appVersion/lang):
      `makeClient` прокидывает deviceModel/systemVersion/appVersion/langCode/systemLangCode
      из сохранённых полей.
- [x] **Шаг 4 — UI «Импорт сессии»** в пуле аккаунтов: форма (.session + .json + прокси + label/лимит) → `POST /accounts/import` (multipart FormData без ручного
      Content-Type); карточка появляется со статусом. Импортированные (с сессией) не
      показывают phone-Login — «коннект при старте через прокси». Пилюля `нужен прокси`.
- [x] **Шаг 5 — Проверка** (без живого коннекта).

### Проверка Фазы 3 (без коннекта к Telegram)

- **Round-trip конвертация ВЕРНА**: на синтетической Telethon-сессии dc_id/ip/port
  сохраняются, `auth_key` байт-в-байт совпадает (256 байт), кривой ключ → ошибка
  (`scripts/test-telethon-import.js` — ALL OK).
- **Миграция**: device/2FA/user_id/source-колонки `tg_account` применяются идемпотентно.
- **importAccount (node)**: app_id→api_id, app_hash→api_hash, device/sdk/app_version/lang/
  user_id/twoFA сохранены; label по умолчанию `First Last (@username)`; статус
  `active` с прокси / `needs_proxy` без; `accountStatus` НЕ отдаёт секреты (только
  `has_2fa`/`source`/`device_model`).
- **HTTP `/accounts/import` (multipart)**: создаёт карточку с session+device, секреты
  в ответе отсутствуют; без прокси → `needs_proxy`.
- **UI**: форма импорта рендерится (скрин `qa-screens/e-import-session-form.png`),
  отправляет multipart, карточка появляется.
- **Синтаксис**: `node --check` по всем файлам + главный inline-скрипт зелёные.

### Принятые дефолты (Фаза 3)

- `.session` (multer memoryStorage) пишется во временный файл (better-sqlite3 нужен
  путь), конвертится, временный файл удаляется в `finally`. Лимит файла 5 МБ.
- proxy из `.json` ИГНОРИРУЕМ — прокси задаём отдельным полем (SOCKS5,
  `host:port:user:pass`).
- Без прокси аккаунт импортируется со статусом `needs_proxy` (в `pickAccount` не
  попадёт, т.к. не active и не залогинен); прокси добавляется через «✎ Прокси/лимит».
- 2FA-пароль (`twoFA`) сохраняется в `tg_account.two_fa` на случай запроса при
  коннекте; в API/логи не отдаётся.
- Секреты (auth_key/session/api_hash/two_fa) не логируются и не возвращаются клиенту.

### Готово к совместному живому коннекту

- Конвертер + импорт + device-параметры готовы. Для живого теста нужен **реальный
  SOCKS5-прокси** на аккаунт (чтобы не светить с домашнего IP) и сами `.session`/`.json`
  (кладём в `tools/yt-parser/tmp/`, оно в .gitignore). Дальше: импорт через UI →
  задать прокси → рестарт сервера (автологин по сессии через прокси) → `getMe` для
  проверки. Это делаем вместе.

## Фаза 4 (дебаунс ответа на входящие TG)

Если блогер шлёт пачку сообщений подряд — агент отвечает ОДИН раз с учётом всей
пачки, а не дёргается на каждое. Правка только в TG-листенере; email/IMAP не трогаем.

- [x] **Шаг 1 — Дебаунс-таймер**: per-lead `setTimeout` по ключу `${wsId}:${leadId}`
      (in-memory Map). Каждое новое входящее → `clearTimeout` + заново на
      `TG_REPLY_DEBOUNCE_MS` (env, дефолт 12000). По «тишине» → `generatePendingReplies`
      в контексте ws лида (читает уже всю пачку). Запись входящего и стадия `replied` —
      мгновенные. env задокументирован в `.env.example`. Reentrancy-guard и review-дедуп
      сохранены.
- [x] **Шаг 2 — Startup-sweep**: при `enableTelegramListener` один отложенный проход
      `sweepStrandedTgReplies()` — по воркспейсам с «зависшей» TG-пачкой (входящие после
      последнего исходящего, без активного черновика). Подбирает пачки, пришедшие пока
      сервер был выключен (таймеры теряются на рестарт); guard/дедуп от дублей.
- [ ] **Шаг 3 — Проверка** (короткий debounce, без реальной отправки).

## Проверка Фазы 2 (UI)

- **Синтаксис**: `node --check` главного inline-скрипта (~4900 строк) зелёный после каждого шага; prettier (husky) зелёный на коммитах.
- **Нет висячих ссылок**: удалённый одно-аккаунтный TG-блок (tgStatusBox/tgCodeInput/renderTgStatus/…) нигде не остался; все `tgLogin/tgSubmitCode/tgSubmitPassword/tgLogout` теперь per-account `(id)`.
- **Контракты fetch (HTTP-смоук)**: `GET /api/leads` → `channels_available`/`channels_sent`; `POST /api/leads/:id/run {channels}` → `{success,channels}`; accounts CRUD (`POST`/`PATCH`/`DELETE`/`login`) по UI-контракту (proxy_string, daily_cap-строкой); `GET /api/dialogues` отдаёт пер-канальные строки с `account_id`+`lead_id`; `/api/dialogues/:id/messages` даёт `dialogue.channel/account_id` и `messages[].dialogue_id` (основа фильтра вкладок). В логе сервера ошибок нет.
- **Данные вкладок чата**: на сид-сценарии (лид с email+telegram диалогами) подтверждено — 2 пер-канальные строки, messages мёржит оба канала, клиентский фильтр `dialogue_id→channel` показывает только выбранный канал; TG-вкладка несёт метку аккаунта.
- Реального логина аккаунтов не делалось (нет кредов) — поток логина даёт понятную ошибку до ввода `api_id/api_hash`. Визуальный QA — совместно.

## Принятые дефолты (Фаза 2)

- Пикер каналов: по умолчанию пред-выбраны доступные и ещё не отправленные каналы; уже отправленные показаны с пометкой и НЕ пред-выбраны (бэкенд всё равно идемпотентно пропустит); WhatsApp — постоянно disabled (`future:true`) до появления транспорта.
- Bulk-пикер: канал доступен, если доступен хотя бы у одного выбранного лида; бэкенд фильтрует доступность per-lead.
- Управление аккаунтами — в Настройках на месте старого TG-блока; легаси-эндпоинты `/api/telegram/login|code|…` фронтом больше не используются (остаются в бэкенде для совместимости).
- Вкладки канала в чате — только если у лида >1 диалога; пер-канальная история = клиентский фильтр по `dialogue_id→channel` (без изменений бэкенда); метка TG-аккаунта из кэша `/api/telegram/accounts` (fallback `acc#N`).
- Бейджи в списке лидов: `ch-sent` (синяя ✓, по `channels_sent`) и `ch-unavail` (приглушённая, по `channels_available`); прочие вызовы `buildContactIcons` без статус-контекста не меняются.

## Готово к совместному визуальному QA

- Пикер каналов при «Запустить» (одиночный и bulk), Настройки → пул аккаунтов (добавить/логин/прокси/лимит/статус/удалить), вкладки канала в чате, бейджи в списке лидов.
- Для живого подключения: 3 аккаунта + 3 прокси + `api_id/api_hash` (общие в `.env` или per-account), затем поэтапный логин из UI. Снятие `DRY_RUN` — на живом тесте вместе.

## Осталось на живой тест (нужно от Бруно)

- 3 реальных TG-аккаунта (phone/code/2FA) + 3 прокси. **Уточнить тип прокси** (SOCKS5 уже готов; MTProxy — заготовка, нужно дореализовать при необходимости).
- API-креды: либо общий `TG_API_ID`/`TG_API_HASH` в `.env` (локально сейчас ПУСТЫЕ), либо per-account `api_id`/`api_hash` при создании аккаунта.
- Снятие `DRY_RUN` и реальная отправка на одном тестовом контакте (вместе, на живом тесте).
- Фаза 2 (UI): попап-пикер каналов, управление 3 аккаунтами/прокси, переключатель канала в чате.
