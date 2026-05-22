# ПУП · TG Service · CLAUDE.md

> Главный файл проекта. Читай первым.

---

## 0. TL;DR

**TG Service** — standalone Python-инструмент для Telegram-маркетинга внутри платформы ПУП.
22 функциональных экрана: аккаунты, парсеры, AI-агенты, рассылки, накрутка, инструменты.

Интегрируется в ПУП через iframe (как YouTube Parser), живёт в `tools/tg-service/`, порт **8001**.

---

## 1. Архитектура

### Позиция в ПУП

```
ПУП (Next.js, порт 3000)
└── Marketing → Parsers
    ├── YouTube Parser (iframe → localhost:3001)  ← уже есть
    └── TG Service    (iframe → localhost:8001)   ← это мы
```

### Как работает

```
Браузер → pupanel.cc/tg-service/?workspace=abc123
    ↓ nginx proxy
localhost:8001 (Python FastAPI — свой UI + API)
    ├── SQLite: data/ws-abc123.db (данные этого workspace)
    ├── Redis db=5 (Celery очереди, rate-limits)
    ├── Telethon (MTProto клиенты Telegram)
    └── Claude API (AI-агенты)
```

### Workspace isolation (главное правило)

**Каждый workspace = своя SQLite БД.** Данные НИКОГДА не шарятся между workspace.

- Файлы: `data/ws-{workspaceId}.db`
- При первом запросе с новым workspaceId → автоматически создаётся БД и применяется schema.sql
- Аккаунты, прокси, настройки, кампании — всё per-workspace
- workspaceId берётся из `?workspace=` query param или `x-workspace-id` header

Это точно паттерн YouTube Parser (`tools/yt-parser/`).

---

## 2. Стек

| Компонент        | Технология                                                            |
| ---------------- | --------------------------------------------------------------------- |
| Web framework    | FastAPI (async)                                                       |
| Telegram client  | Telethon                                                              |
| Task queue       | Celery + Redis (db=5)                                                 |
| Scheduler        | Celery Beat                                                           |
| Database         | SQLite per workspace (better-sqlite3 аналог через aiosqlite)          |
| Embeddings (RAG) | Локальные (sentence-transformers / fastembed), НЕ Voyage AI           |
| LLM              | Anthropic API (Claude Haiku 4.5 default, Sonnet/Opus через настройки) |
| Process manager  | PM2                                                                   |
| Python           | 3.12                                                                  |
| Package manager  | pip + venv                                                            |
| Encryption       | AES-256-GCM (cryptography)                                            |
| Logging          | structlog (JSON)                                                      |
| Frontend         | Встроенный HTML/CSS/JS (как yt-parser)                                |

### Чего НЕ используем

- ❌ PostgreSQL (SQLite per workspace)
- ❌ pgvector (локальные embeddings)
- ❌ Voyage AI (локальные модели)
- ❌ Alembic (встроенный schema.sql)
- ❌ Docker / Kubernetes
- ❌ Pyrogram (только Telethon)
- ❌ NestJS (у нас Next.js, но TG Service самостоятельный)
- ❌ SMS-регистрация аккаунтов (только импорт готовых)

---

## 3. Структура папок

```
tools/tg-service/
├── CLAUDE.md                    # этот файл
├── README.md                    # quickstart
├── requirements.txt             # Python зависимости
├── .env.example                 # шаблон env
├── .env                         # реальные секреты (gitignored)
├── .gitignore
├── ecosystem.config.js          # PM2 конфиг
├── schema.sql                   # SQLite schema (применяется при создании БД)
│
├── app/
│   ├── __init__.py
│   ├── main.py                  # FastAPI entry point
│   ├── config.py                # pydantic settings
│   ├── deps.py                  # DI dependencies
│   │
│   ├── api/                     # HTTP routes
│   │   ├── __init__.py
│   │   └── v1/
│   │       ├── __init__.py
│   │       ├── smoke.py         # smoke-test endpoints
│   │       ├── accounts.py
│   │       ├── proxies.py
│   │       └── ...
│   │
│   ├── core/
│   │   ├── __init__.py
│   │   ├── security.py          # AES-256-GCM + auth
│   │   ├── logging.py           # structlog config
│   │   ├── errors.py            # custom exceptions
│   │   └── database.py          # SQLite per-workspace manager
│   │
│   ├── tasks/
│   │   ├── __init__.py
│   │   ├── celery_app.py        # Celery instance
│   │   └── beat_schedule.py     # периодические задачи
│   │
│   ├── telegram/
│   │   ├── __init__.py
│   │   └── client_pool.py       # Telethon client manager
│   │
│   ├── ai/
│   │   ├── __init__.py
│   │   ├── anthropic_client.py
│   │   └── embeddings.py        # локальные embeddings
│   │
│   └── services/                # бизнес-логика (по мере роста)
│       └── __init__.py
│
├── public/                      # Frontend (HTML/CSS/JS)
│   ├── index.html               # Dashboard SPA
│   └── login.html               # Auth (если нужен)
│
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   └── unit/
│       ├── __init__.py
│       └── test_security.py
│
└── data/                        # рантайм (gitignored)
    ├── ws-default.db            # SQLite для workspace "default"
    ├── ws-{workspaceId}.db      # SQLite для каждого workspace
    └── sessions/                # зашифрованные Telethon session файлы
```

---

## 4. Roadmap (6 этапов)

| Stage       | Что                                                                    | Статус      |
| ----------- | ---------------------------------------------------------------------- | ----------- |
| **STAGE 0** | Инфраструктура: FastAPI + SQLite + Celery + Redis + AES-256 + PM2      | 🔨 В работе |
| **STAGE 1** | Аккаунты + Прокси + Конвертер + Прогрев                                | ⏳          |
| **STAGE 2** | Парсер + Базы аудитории + Каналы + Чекер + Дашборд                     | ⏳          |
| **STAGE 3** | AI Промоутер + AI Продажник + Нейрокомментинг + Автоответчик + Шаблоны | ⏳          |
| **STAGE 4** | Рассылка в ЛС + Рассылка по чатам + Инвайтинг                          | ⏳          |
| **STAGE 5** | Накрутка + Масслайкинг + Клонер + Создание чатов + Настройки           | ⏳          |

---

## 5. Ключевые принципы

### 5.1 Anti-ban first

- Активные часы 09:00-22:00
- Случайные задержки между действиями
- Лимиты per account per day (DM 30, посты 3, комменты 10, инвайты 180)
- Ramp-up для холодных кампаний
- Emergency stop при >30% банов
- FloodWait → пауза акк на 24ч

### 5.2 AI cost control

- Default Haiku 4.5
- Sonnet для критичных задач
- Hard limit $500/мес
- Дневной отчёт расхода

### 5.3 Session security

- Все session-файлы AES-256-GCM encrypted
- Master key в `.env` как `PUP_SECRET`
- Расшифровка только in-memory
- Audit log операций с session-файлами

### 5.4 Стиль кода

- Python: ruff + black (line length 100)
- Type hints обязательно
- Всё async/await
- structlog с context (workspace_id, account_id)
- Custom exceptions в `app/core/errors.py`

---

## 6. Связь с оригинальным ТЗ

Оригинальные документы в `/tmp/tg-parser-handoff/pup-telegram-handoff/`:

- `pup-telegram-tz-v2.md` — полное ТЗ (22 экрана, бизнес-логика)
- `schema.prisma` — полная Prisma-схема (35+ моделей, reference)
- `models.py` — SQLAlchemy-модели (reference для Python-стороны)
- `wireframes/` — 22 HTML wireframe'а
- `STAGE_0_PROMPT.md` — оригинальный промпт Stage 0

Эти документы — **reference**, но архитектура адаптирована (см. CLAUDE.md раздел 1-2).

---

**Версия:** v1.0 · 21 мая 2026
**Автор:** Bruno + Claude (через ПУП)
