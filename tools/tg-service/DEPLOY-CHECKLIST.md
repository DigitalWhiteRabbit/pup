# TG Service · DEPLOY-CHECKLIST (первый прод-деплой на VPS)

> Runbook первого деплоя `tools/tg-service` на прод-VPS. Ветка `wip/migration`.
> Готовился локально; на VPS ничего ещё не делалось.
>
> ⚠️ **На `main` настроен GitHub auto-deploy (push в main = деплой).** Этот
> чеклист НЕ требует мержа в main для самого tg-service — сервис на VPS
> разворачивается/рестартится отдельно (Python venv + PM2), а не Node-пайплайном
> CI (`.github/workflows/ci.yml` — это pnpm/Node для основного PUP-приложения).
> **См. открытый вопрос Q1** — как именно код tg-service попадает на VPS.
>
> Принцип: каждый шаг помечен **[обратимость]**. Делать по порядку; на каждом
> шаге — проверка, прежде чем идти дальше.

---

## 0. Предусловия (проверить ДО начала)

- [ ] На VPS: Python 3.12, Redis (для Celery-брокера, db=5), PM2, nginx, SQLite **≥ 3.35** (нужно для одной guarded `DROP COLUMN`-миграции; при <3.35 миграция мягко пропустится — не критично).
- [ ] Есть персистентный путь под данные (`DATA_DIR`, `SESSIONS_DIR`) — НЕ внутри git-checkout (чтобы `data/ws-*.db` и зашифрованные сессии переживали редеплой). **Q2.**
- [ ] Решено, greenfield или поверх старого skeleton-tg-service (на `main` лежит ранняя версия, 59 файлов). **Q3.**

---

## 1. Доставка кода на VPS · [обратимо: да — checkout прежнего commit]

- [ ] Завести код ветки `wip/migration` на VPS в `tools/tg-service` (способ — см. **Q1**; например `git fetch && git checkout <commit>` в отдельном рабочем дереве, БЕЗ мержа в main).
- [ ] Зафиксировать предыдущий commit/状态 (для отката).
- **Откат:** `git checkout <prev_commit>` + `pm2 restart` старого кода.

## 2. Зависимости (Python venv) · [обратимо: да — пересоздать venv]

- [ ] `python3.12 -m venv .venv`
- [ ] `.venv/bin/python -m pip install -r requirements.txt`
- [ ] requirements.txt **полностью запинен** и включает всё новое:
      `fastembed==0.8.0`, `numpy==2.4.6`, `python-socks[asyncio]==2.5.3`,
      `httpx[socks]==0.27.2`, `telethon==1.37.0`, `anthropic==0.39.0`, `cryptography`,
      `celery[redis]`, `fastapi`, `uvicorn`, … (onnxruntime/tokenizers подтянутся как
      зависимости fastembed). `aiosqlite` НЕ нужен (БД — синхронный `sqlite3`).
- [ ] Проверка: `.venv/bin/python -c "import app.main"` → без ошибок.
- **Откат:** удалить `.venv`.

## 3. Прогрев fastembed-модели (~0.22 ГБ) · [обратимо: да — удалить кэш]

Модель `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` тянется с
HuggingFace при ПЕРВОМ обращении к гибридному RAG (P6-01).

- [ ] Прогреть кэш заранее (чтобы не ловить задержку/сбой в первом запросе):
  ```
  .venv/bin/python -c "from app.ai.embeddings import is_available; print('embed:', is_available())"
  ```
  Должно скачать модель и напечатать `embed: True`. Кэш — в `~/.cache/...` (HF/fastembed).
- [ ] **Офлайн/без сети:** деградация штатная — `is_available()` вернёт False, RAG
      переключается на keyword-only (`app/ai/embeddings.py`, graceful-fallback). Сервис
      НЕ падает. Допустимо ли работать без вектора на старте — **Q4**.
- **Откат:** удалить кэш модели (вернётся keyword-fallback). Необратимых изменений нет.

## 4. Конфиг / секреты / env · [обратимо: да — правка .env]

`.env` рядом с сервисом (значения НЕ в репо). Ключи (см. `app/config.py`, `.env.example`):

| Ключ                                                        | Назначение                                                         | Критично                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `PUP_SECRET`                                                | base64 32-байтный мастер-ключ AES-256-GCM сессий                   | ⚠️ **должен совпадать** с ключом, которым шифровались существующие session-файлы — иначе сессии не расшифруются (**Q5**) |
| `ADMIN_TOKEN`                                               | x-admin-token для API/UI                                           | да (заменить дефолт)                                                                                                     |
| `REDIS_URL` / `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | Redis (db=5)                                                       | да — Celery без брокера не работает (**Q6**)                                                                             |
| `ANTHROPIC_API_KEY`                                         | Claude (AI-агент/комменты/идентичности/RAG-ответы)                 | да для AI-функций                                                                                                        |
| `TELEGRAM_APP_ID` / `TELEGRAM_APP_HASH`                     | дефолтные TG-креды (per-account в metadata)                        | по ситуации                                                                                                              |
| `NOTIFY_BOT_TOKEN` / `NOTIFY_CHAT_ID`                       | админ-уведомления (emergency/spam_block/…); без них notify = no-op | желательно                                                                                                               |
| `DATA_DIR` / `SESSIONS_DIR`                                 | персистентные пути БД/сессий                                       | да (вне git-дерева)                                                                                                      |
| `ENVIRONMENT` / `DEBUG` / `LOG_LEVEL` / `APP_PORT(8001)`    | окружение                                                          | дефолты ок                                                                                                               |

- [ ] Заполнить `.env`, проверить права (chmod 600).
- **Откат:** правка/восстановление `.env`.

## 5. БД-миграции (идемпотентные, при первом старте) · [обратимо: частично — см. ниже]

Миграции применяются **автоматически** при инициализации БД (`app/core/database.py`),
отдельного шага запускать не надо — но понимать, что произойдёт:

- **Чистая прод-БД** (новый workspace): `schema.sql` создаёт **48 таблиц**; затем
  runtime-миграции до-создают то, чего нет в schema.sql (`tg_ai_activity`,
  `tg_style_samples`) и применяют guarded `ALTER`-ы (на чистой БД колонки уже есть → пропуск).
- **Существующая прод-БД** (поверх skeleton): `schema.sql` НЕ переприменяется (только
  на fresh); вместо этого ~41 `CREATE TABLE IF NOT EXISTS` + ~18 guarded `ALTER ADD COLUMN`
  (каждый под `PRAGMA table_info`-проверкой) до-катывают новые таблицы/колонки. **Аддитивно**, без потери данных.
- Все `ALTER`-ы идемпотентны (повторный старт ничего не ломает).
- ⚠️ Одна **`DROP COLUMN`** (`tg_settings.proxy_seller_api_key`, legacy-чистка) — деструктивна,
  но в `try/except` и срабатывает только если колонка ещё есть; требует SQLite ≥3.35,
  иначе тихо пропускается.
- [ ] Проверка после первого старта: открыть UI/`/system`, убедиться что воркспейс-БД создалась без ошибок в логах (`grep -i "migration_failed\|Traceback" logs/`).
- **Откат:** новые таблицы/колонки безвредны для старого кода (он их игнорирует);
  при откате кода БД-схему откатывать НЕ нужно. **Бэкап `data/ws-*.db` перед стартом — обязателен** (см. шаг 8).

## 6. PM2 — процессы сервиса (порт 8001) · [обратимо: да — pm2 delete]

`ecosystem.config.js` уже описывает 3 процесса (cwd = папка сервиса):

- `pup-tg-api` — uvicorn `app.main:app` :8001, **2 воркера**, max_mem 500M.
- `pup-tg-worker` — Celery worker, `--concurrency=4` (prefork; **в dev был threads+filesystem**, в prod — prefork+Redis), max_mem 1G.
- `pup-tg-beat` — Celery Beat (периодика: reaper/continuity/health-check/scheduler).

- [ ] `pm2 start ecosystem.config.js` (из папки сервиса).
- [ ] `pm2 save` (чтобы пережило ребут).
- [ ] Проверка: `pm2 status` → 3 процесса online; `pm2 logs pup-tg-api` без трейсбеков.
- ⚠️ **RAM:** fastembed-модель грузится **по процессу** при первом KB-вызове (api×2 + worker×4 prefork). Если все загрузят модель — до ~6 копий ⇒ возможны рестарты по `max_memory_restart`. **Рекомендация:** на старте поднять `max_memory_restart` worker'а и/или снизить `--concurrency`; финально — **Q7**.
- **Откат:** `pm2 delete pup-tg-api pup-tg-worker pup-tg-beat` + запустить старый процесс.

## 7. nginx — роут `/tg-service/` → `127.0.0.1:8001` · [обратимо: да]

По образцу yt-parser (`/yt-parser/` → :3001), tg-service встраивается iframe'ом
(`pupanel.cc/tg-service/?workspace=...`).

- [ ] Добавить `location /tg-service/ { proxy_pass http://127.0.0.1:8001/; ... }`
      (прокинуть `X-Forwarded-*`; снять/настроить `X-Frame-Options`/CSP для iframe — как у yt-parser). Точный конфиг — **Q8** (домен/путь/CSP).
- [ ] `nginx -t` → ok; `systemctl reload nginx`.
- [ ] Проверка: `curl -s https://<домен>/tg-service/api/v1/system/status -H 'x-admin-token:...'`.
- **Откат:** убрать `location`-блок + `nginx -s reload`.

## 8. Бэкап + финальная проверка · [обратимо]

- [ ] **ПЕРЕД стартом нового кода: бэкап `DATA_DIR` (все `ws-*.db`) и `SESSIONS_DIR`.** Это главный путь отката данных.
- [ ] После старта — прогнать **SMOKE-TEST.md** (то, что dev не мог проверить).
- [ ] Следить ~30 мин: `pm2 logs` на трейсбеки / OOM-рестарты / `migration_failed`.

---

## Полный откат деплоя (если что-то пошло не так)

1. `pm2 restart` предыдущего кода (или `pm2 delete` новых + старый процесс).
2. `git checkout <prev_commit>` рабочего дерева сервиса.
3. Восстановить `DATA_DIR`/`SESSIONS_DIR` из бэкапа (шаг 8) — **только если новые миграции реально мешают** (обычно не нужно: аддитивны).
4. nginx — убрать новый `location` (или вернуть прежний).
   Откат не затрагивает `main` (туда ничего не пушилось).

---

## Открытые вопросы к владельцу (инфра/секреты — не придумываю)

- **Q1.** Как код tg-service (Python) попадает на VPS и рестартится? CI на main — это pnpm/Node для основного PUP. Для tg-service — отдельный `git pull`+`pm2 restart` вручную? Нужен ли `deploy.sh`/webhook?
- **Q2.** Пути `DATA_DIR` / `SESSIONS_DIR` на VPS (персистентный том вне git-дерева)?
- **Q3.** Greenfield или поверх существующего skeleton-tg-service? Есть ли уже `ws-*.db` с данными / зашифрованные сессии для переноса?
- **Q4.** Допустимо ли стартовать с keyword-fallback (без вектора), если модель не прогрелась, — или прогрев модели обязателен до открытия доступа?
- **Q5.** `PUP_SECRET`: новый ключ (greenfield) или должен совпасть с ключом существующих session-файлов? (Без совпадения сессии не расшифруются.)
- **Q6.** Redis на VPS: какой инстанс/URL, db=5 свободна? (Целевой брокер Celery.)
- **Q7.** Лимиты RAM под worker с учётом fastembed-модели по процессу: оставить concurrency=4 или снизить? Поднимать `max_memory_restart`?
- **Q8.** Домен/путь (`/tg-service/`) и CSP/iframe-политика nginx — как у yt-parser?
- **Q9.** Ключи `ANTHROPIC_API_KEY`, `NOTIFY_BOT_TOKEN`/`NOTIFY_CHAT_ID`, `ADMIN_TOKEN`, `TELEGRAM_APP_ID/HASH` — значения для прода.
