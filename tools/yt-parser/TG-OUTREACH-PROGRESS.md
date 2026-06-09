# TG Multichannel Outreach — Фаза 1 (бэкенд)

Ветка: `feat/tg-multichannel-outreach`. НЕ мёржить в main, НЕ деплоить.
ТЗ: `../../TZ-telegram-outreach.md` (корень PUP). Тест-режим: `DRY_RUN=true`, проверка через curl/логику.

## Чек-лист шагов

- [x] **Шаг 1 — Схема БД**: таблица `tg_account` + `dialogues.account_id` (идемпотентно).
- [ ] **Шаг 2 — Пул аккаунтов**: рефактор `telegram-outreach.js` из single → пул (Map), per-account login/status/logout, автологин всех active, `pickAccount()` round-robin по здоровью, `sendMessageVia()`, per-account listener (тег account_id). API для CRUD аккаунтов.
- [ ] **Шаг 3 — Прокси (SOCKS5)**: билдер proxy-опции для TelegramClient из полей `tg_account`; заготовка под MTProxy (`proxy_type`).
- [ ] **Шаг 4 — Анти-бан**: пейсинг-очередь TG с джиттером 30–90с; per-account дневной лимит + ramp-up по `first_used_at`; обработка `FloodWaitError` → `flood_until`.
- [ ] **Шаг 5 — Выбор каналов**: `POST /api/leads/:id/run` принимает `channels[]`; доступность отдаётся в данных лида; рассылка по КАЖДОМУ выбранному каналу (своя запись dialogue+message, свой incrementDailyCount, account_id для TG); идемпотентность по каналу; ревью-режим — строка в pending_replies на канал.
- [ ] **Шаг 6 — Входящие + approve под TG**: надёжный матч лида + тег account_id; approve шлёт через `sendMessageVia` тем же аккаунтом из `dialogues.account_id`.
- [ ] **Шаг 7 — Проверка**: curl всех новых эндпоинтов при DRY_RUN, lint, рестарт dev-сервера, обновление этого файла.

## Принятые дефолты

- `tg_account` хранится в БД **default workspace** (как и текущая `settings.telegram_session`); модуль `telegram-outreach.js` работает с default-БД. Миграция создаёт таблицу во всех ws-БД (безвредно).
- Прокси по умолчанию `proxy_type='socks5'`, формат входных данных `host:port:user:pass`. MTProxy — заготовка (ветка по `proxy_type`).
- Пейсинг-джиттер: env `TG_PACING_MIN_MS`/`TG_PACING_MAX_MS` (дефолт 30000/90000). Очередь общая для всех аккаунтов (gap между любыми TG-отправками).
- Ramp-up: день1=5, день2=10, … шаг +5/день до `daily_cap` (по `first_used_at`; если null — день1).
- Авто-очередь (`processOutreachQueue`) без явных каналов → шлёт по ВСЕМ доступным каналам лида (раньше слала только один). Идемпотентность — по каналу.
- Легаси-эндпоинты `/api/telegram/status|login|code|password|logout` сохранены (мапятся на первый аккаунт пула) до Фазы 2.

## Осталось на живой тест (нужно от Бруно)

- 3 реальных TG-аккаунта (phone/code/2FA) + 3 прокси (тип уточнить: SOCKS5/MTProxy).
- Снятие `DRY_RUN` и реальная отправка на одном тестовом контакте.
