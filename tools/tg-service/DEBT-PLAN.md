# План закрытия технического долга TG Service

## Приоритет 1 — КРИТИЧНО (без этого нельзя тестить)

### ✅ 1.1 Подключить dispatch Celery задач в "start" endpoints

**Статус:** DONE (2026-05-22)
**Результат:** Все 10 start endpoints dispatch'ат реальные Celery задачи

### ✅ 1.2 Написать Celery worker для парсинга (dispatch fix)

**Статус:** DONE (2026-05-21)
**Результат:** `pup_tg.parse_audience` — рабочий, протестирован на реальной группе

### ✅ 1.3 Дописать 5 placeholder режимов парсинга

**Статус:** DONE (2026-05-21)
**Результат:** Все 8 режимов парсинга реализованы (REACTIONS, POLLS, JOINERS, TOPICS, GLOBAL_SEARCH)

### ✅ 1.4 Подключить Anthropic API (Claude)

**Статус:** DONE (2026-05-21)
**Результат:** `app/ai/anthropic_client.py` — `generate_message()` + `generate_chat()`, smoke-test работает

## Приоритет 2 — ВАЖНО (нужно для полноценного тестирования)

### ✅ 2.1 Написать workers для рассылок

**Статус:** DONE (2026-05-22)

- `pup_tg.dm_campaign` — DM рассылка (протестирован, 3/3 доставлено)
- `pup_tg.chat_broadcast` — рассылка по чатам
- `pup_tg.invite_campaign` — инвайтинг в группы (DIRECT + INVITE_LINK)

### ✅ 2.2 Написать worker для AI Промоутера

**Статус:** DONE (2026-05-22)

- `pup_tg.ai_promoter` — мониторинг чатов + Claude ответы
- Поддержка: schedule, approval_mode, strategy (soft/medium/aggressive)

### ✅ 2.3 Написать worker для Автоответчика

**Статус:** DONE (2026-05-22)

- `pup_tg.auto_replier` — polling диалогов, trigger matching, AI/template ответы

### 2.4 Протестировать warmup на реальных аккаунтах

**Что:** warmup_session написан но не тестирован
**Время:** 1-2 часа
**Результат:** Подтверждение что прогрев работает

## Приоритет 3 — НУЖНО (для продакшен-готовности)

### 3.1 Написать тесты на основные API модули

**Что:** 0% покрытие для 148+ endpoints
**Время:** 6-8 часов
**Результат:** Хотя бы 30% покрытие (CRUD + start/stop lifecycle)

### ✅ 3.2 Написать workers для накрутки и инструментов

**Статус:** DONE (2026-05-22)

- `pup_tg.boost_task` — подписка, реакции, просмотры, голосование
- `pup_tg.stories_boost` — просмотр + реакции на сторис
- `pup_tg.cloner_task` — клонирование постов + AI-рерайт
- `pup_tg.channel_creator` — создание каналов/групп
- `pup_tg.converter_task` — конвертация форматов сессий

### 3.3 AI Продажник worker + RAG

**Что:** Claude + Telethon + Knowledge Base embeddings
**Время:** 8-10 часов
**Результат:** Автоматические sales-диалоги в ЛС

### 3.4 Нейрокомментинг worker

**Что:** Мониторинг новых постов + AI-комментарии
**Время:** 4-6 часов (commenting.py — единственный с placeholder dispatch)

## Приоритет 4 — УЛУЧШЕНИЯ (можно отложить)

### 4.1 Миграция SQLite → PostgreSQL

**Когда критично:** 50+ аккаунтов или 100K+ аудитория
**Время:** 2-3 дня

### 4.2 Разрезка HTML на React-компоненты

**Когда критично:** второй разработчик или активная UI-доработка
**Время:** 3-5 дней

---

## Зарегистрированные Celery задачи (17 шт.)

| Задача                    | Файл                     | Статус                  |
| ------------------------- | ------------------------ | ----------------------- |
| `pup_tg.parse_audience`   | parsing_tasks.py         | ✅ Реальный             |
| `pup_tg.dm_campaign`      | dm_campaign_tasks.py     | ✅ Реальный             |
| `pup_tg.chat_broadcast`   | chat_broadcast_tasks.py  | ✅ Реальный             |
| `pup_tg.invite_campaign`  | invite_campaign_tasks.py | ✅ Реальный             |
| `pup_tg.ai_promoter`      | ai_promoter_tasks.py     | ✅ Реальный             |
| `pup_tg.auto_replier`     | auto_replier_tasks.py    | ✅ Реальный             |
| `pup_tg.boost_task`       | stage5_tasks.py          | ✅ Реальный             |
| `pup_tg.stories_boost`    | stage5_tasks.py          | ✅ Реальный             |
| `pup_tg.cloner_task`      | stage5_tasks.py          | ✅ Реальный             |
| `pup_tg.channel_creator`  | stage5_tasks.py          | ✅ Реальный             |
| `pup_tg.converter_task`   | stage5_tasks.py          | ✅ Реальный             |
| `pup_tg.warmup_session`   | warmup_tasks.py          | ✅ Реальный             |
| `pup_tg.warmup_check`     | warmup_tasks.py          | ✅ Реальный             |
| `pup_tg.resolve_channel`  | channel_tasks.py         | ✅ Реальный             |
| `pup_tg.beat_heartbeat`   | beat_schedule.py         | ✅ Системный            |
| `pup_tg.echo`             | celery_app.py            | ✅ Smoke-test           |
| `pup_tg.placeholder_task` | placeholder_tasks.py     | ⚠️ Только commenting.py |
