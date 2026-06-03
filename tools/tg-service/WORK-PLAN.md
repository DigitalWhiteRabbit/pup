# TG Service · WORK-PLAN

> Источник истины очерёдности. Производное от `FEATURE-AUDIT.md`.
> Идём строго сверху вниз. После каждой задачи: `[x]` + ссылка на коммит + инкрементальный коммит.
> Конец фазы: полный регресс `scripts/regression_screens.py`, тестовые записи удалить, аккаунты вернуть в исходный статус.
>
> Статусы: `[ ]` todo · `[x]` done (commit) · `[~]` in progress · `[B]` BLOCKED (вопрос ниже).
> Колонки задачи: **id** · раздел · суть · объём(S/M/L) · риск.
>
> Старт: ветка `wip/migration`, база `fd240e1`. Сервер :8001 (filesystem-брокер + воркер) поднят.

---

## Сводка по фазам

| Фаза      | Тема                                            | Задач  | Статус   |
| --------- | ----------------------------------------------- | ------ | -------- |
| 1         | Починка сломанного + безопасность               | 12     | ✅ 12/12 |
| 2         | «Фантомные» config-поля (подключить или скрыть) | 11     | ✅ 11/11 |
| 3         | Quick wins по разделам (S/low)                  | 21     | ✅ 21/21 |
| 4         | Средние улучшения (M, low-med)                  | 28     | ✅ 28/28 |
| 5         | Сквозная инфраструктура (общие компоненты)      | 9      | ✅ 9/9   |
| 6         | Крупные/стратегические (L, med+)                | 11     | ✅ 11/11 |
| **Итого** |                                                 | **92** |          |

---

> **P1, P2 → см. [WORK-PLAN-DONE.md](WORK-PLAN-DONE.md)** (все задачи закрыты, регресс чист)
> Отложенные под-задачи из P2: **P2-10b** (ai_agent hot-path notify_admin_pref — адаптировать отдельным заходом с live-прогоном ai_agent)

---

## ФАЗА 3 — Quick wins по разделам (S, low risk)

- [x] **P3-01** · accounts · Бейджи здоровья уже были в колонке Статус (healthBadges). Добавлен фильтр `accHealthF` (Ограничен/scam/fake · Без профиля · Низкий humanity) + сброс. Live playwright: ALL=10, RESTRICTED=0, NOPROFILE=5, reset виден, без console-ошибок. _(commit P3-01)_
- [x] **P3-02** · account*profile · `POST /{id}/profile/upload-avatar` (multipart, валидация image+размер) — сохраняет в тот же \_avatar_path; кнопка «⬆ Загрузить свой» во вкладке Профиль. Генерация: `_download_avatar_bytes` пробует thispersondoesnotexist → fallback i.pravatar.cc?u={account_id} (seed, лечит частые 403). Live: upload→200+avatar_url, GET→200 image/jpeg 2000B, text→400, disposable cleaned. *(commit P3-02)\_
- [x] **P3-03** · account*profile · Блок «Предпросмотр — как увидят аккаунт» во вкладке Профиль (аватар+имя+@username+bio+privacy), live-обновление по input полей (pfUpdatePreview). Live playwright: блок есть, ввод «Иван» → превью обновилось, JS-ошибок нет (404 — отсутствующий файл аватара, штатно). *(commit P3-03)\_
- [x] **P3-04** · account*profile · Pre-check занятости username (CheckUsername) до apply. S · low-med. Live: bad_format→400, no_proxy→400(NO_PROXY), UI ✓ (playwright). Полный live с TG-клиентом ограничен (нужен прокси). *(commit 12897d0)\_
- [x] **P3-05** · proxies · Расширенные форматы импорта (socks5://user:pass@host:port, rotation*url). S · low. Бонус: починен /proxies/bulk (UI вызывал несуществующий эндпоинт). Live: bulk imported=1, parser 5/5 ✓, UI ✓. *(commit 19d2c1b)\_
- [x] **P3-06** · proxies · Beat-задача авто-EXPIRED для истёкших + бейдж. S · low. Live: task ran expired=1 ✓, UI бейдж EXPIRED уже был в psBdg. _(commit 3aa87c2)_
- [x] **P3-07** · dashboard · Полнота словарей статусов/типов (INVALID, ISP). S · low. Live: ISP/RESIDENTIAL в диалоге ✓, INVALID/NO*PROXY в pool дашборда, без JS-ошибок. *(commit 21e1d66)\_
- [x] **P3-08** · dashboard · Виджеты парсера/чекера/аудиторий (найдено за месяц, размер баз). S · low. Live: 3 виджета в дашборде, API возвращает поля ✓. _(commit 81113e0)_
- [x] **P3-09** · dashboard · Кэш агрегата 15-30с. S · low. DASH*TTL=20s + stale-check, refresh сбрасывает таймер. *(commit 96b8f07)\_
- [x] **P3-10** · parser · Авто-поллинг прогресса RUNNING-задач. S · low. prsStartPoll/prsStopPoll, 5s, авто-стоп при nav-away. _(commit bee6f3c)_
- [x] **P3-11** · parser · Пауза/возобновление в UI (бэк умеет PAUSED→start). S · low. RUNNING→Пауза(/pause), PAUSED→Продолжить(/start), Cancel-иконка для non-terminal. _(commit b2ad86d)_
- [x] **P3-12** · parser · Выбор существующей аудитории + premium*only в UI-модалке. S · low. Dropdown с существующими аудиториями + Не сохранять + premium_only checkbox. *(commit 5bfea9a)\_
- [x] **P3-13** · audiences · Кнопка экспорта/скачивания (CSV/JSON, бэк /export готов). S · low. ↓JSON / ↓CSV кнопки, blob-download на клиенте. _(commit 7853ede)_
- [x] **P3-14** · audiences · Фильтры/поиск + пагинация в детальной странице. S · low. Поиск 350ms debounce + Пред/След (50/стр). _(commit df78245)_
- [x] **P3-15** · channels · Инлайн-редактирование роли/категории (PATCH готов). S · low. Inline select/input, PATCH on change/debounce. _(commit e88c84f)_
- [x] **P3-16** · channels · Сохранять about/members*count при resolve→POST. S · low. *(commit e88c84f)\_
- [x] **P3-17** · channels · Кнопка «Спарсить» из строки канала (→parser). S · low. _(commit e88c84f)_
- [x] **P3-18** · phone-checker · Сохранение найденных в аудиторию. S · low. add-members endpoint + UI диалог. _(commit aea25ac)_
- [x] **P3-19** · phone-checker · Импорт номеров из файла + экспорт результатов. S · low. FileReader import + CSV blob download. _(commit aea25ac)_
- [x] **P3-20** · ai-promoter · Экспорт 👍-реплик в Style Bank/Arena-корпус. S · low. Кнопка «📚 В Стиль-банк» в learning tab. _(commit edcb4c7)_
- [x] **P3-21** · style*bank · Привязка topic стиль-банка к персоне (поле в персоне). S · low. style_topic колонка + wizard шаг 4. *(commit edcb4c7)\_

**Регресс Ф3:** `scripts/regression_screens.py` → 26/26 чисто. Тестовых записей нет. Аккаунты 9 ACTIVE + 1 INVALID. WARMING 0.

---

## ФАЗА 4 — Средние улучшения (M, low-med)

- [x] **P4-01** · warmup · Bulk-старт/стоп прогрева на экране (выбор пачки аккаунтов). S · low. Чекбоксы в таблице + «Стоп выбранных» + «Все». _(commit b1905bc)_
- [x] **P4-02** · warmup · Уведомление «аккаунт прогрет» (notif*warmup_ready). S · low. notify_admin_pref при level==100; live-тест ограничен (нужен реальный warmup-цикл). *(commit 862d35b)\_
- [x] **P4-03** · warmup · График прогресса по дням из логов. S · low. GET /warmup/progress + CSS bar chart. _(commit b32e70f)_
- [x] **P4-04** · warmup*scripts · Создать UI-экран (конструктор + история run'ов; бэк готов). M · low. *(commit 4344f47)\_
- [x] **P4-05** · warmup*scripts · Объединить со «Прогрев» как вкладку. S · low. *(commit 4344f47)\_
- [x] **P4-06** · stories-boost · Авто-определение последней сторис (GetPeerStories). S · low. GetPeerStoriesRequest → max story*id, fallback=skip. Live ограничен (нужна реальная сторис+аккаунт). *(commit dcf67c0)\_
- [x] **P4-07** · boost · Ротация аккаунтов по здоровью + round-robin. S · low. ORDER BY warmup*level DESC + rotation_cursor в config. *(commit 02741f0)\_
- [x] **P4-08** · boost · Множественные эмодзи с весами для реакций. S · low. Multi-toggle UI + random.choice в воркере. _(commit 59a2c15)_
- [x] **P4-09** · cloner · Дедуп/докопирование (курсор last*cloned_id). S · low. min_id=last_cloned_id + персистируем в schedule_config. *(commit 2879724)\_
- [x] **P4-10** · cloner · Фильтры контента (пропуск рекламы/по ключевым словам). S · low. skip*ads (forwards+hashtags) + skip_keywords. *(commit 0f40826)\_
- [x] **P4-11** · converter · Скачивание результата + audit. S · med. GET /download → ZIP stream + audit*logs + UI кнопка. *(commit 3294fd5)\_
- [x] **P4-12** · converter · Страна по номеру + проверка живости. S · low. GET /converter/phone-country + виджет в UI. Live: +7→RU+Tele2 ✓. _(commit 9d123a2)_
- [x] **P4-13** · join-chats · Дневной лимит вступлений per-account. S · med. daily*limit в config (default 50) + UI-инпут. *(commits 5309f3c, 15d672d)\_
- [x] **P4-14** · join-chats · Авто-стоп при серии BANNED*AFTER_JOIN. S · low. ban_auto_stop_count (default 3) + UI-инпут. *(commits 5309f3c, 15d672d)\_
- [x] **P4-15** · join-chats · Retry проблемных (FAILED) чатов. S · low. POST /retry-failed + UI кнопка. _(commit 5309f3c)_
- [x] **P4-16** · channel-creator · Распределение создания по нескольким аккаунтам (round-robin). M · med. _(commit 46908db)_
- [x] **P4-17** · channel-creator · Лимит создания per-account + ramp-up. S · med. _(commit 46908db)_
- [x] **P4-18** · channel-creator · Инкрементальный прогресс created*count. S · low. *(commit 46908db)\_
- [x] **P4-19** · channel-creator · Авто-связка is*own каналов как target. S · low. *(commit 46908db)\_
- [x] **P4-20** · dm-campaign · Детект ответов (REPLIED) + конверсия. M · low. POST /check-replies + UI кнопка. Live ограничен (нужен реальный TG). _(commit a01fc40)_
- [x] **P4-21** · dm-campaign · Дневной лимит между запусками (account*daily_usage). S · med. Разблокирован P5-01: DM-движок гейтит по get_usage(ACTION_DM) ≥ daily_limit (cross-campaign + restart-safe). *(commit 2b5a705)\_
- [x] **P4-22** · chat-broadcast · Детект удаления постов (survival*rate). M · low. POST /check-survival + UI кнопка. *(commit eea84a2)\_
- [x] **P4-23** · chat-broadcast · Пауза/резюм + PATCH. S · low. POST /pause + /resume + UI кнопка. _(commit eea84a2)_
- [x] **P4-24** · inviting · Пауза/резюм. S · low. POST /pause + /resume + UI кнопка. _(commit eea84a2)_
- [x] **P4-25** · neuro-commenting · Дедуп/история откомментированных постов + лог в UI. S · low. GET /commenting/tasks/{id}/log + 📋 модальный лог. Dedup был в воркере. _(commit 6e6c700)_
- [x] **P4-26** · templates · AI-генерация вариантов (ai*personalization-флаг). S · low. POST /generate-variants (Haiku, 3 шт) + UI кнопка. *(commit 6e6c700)\_
- [x] **P4-27** · kb · Авто-self-test/conflict-check после upload + бейдж здоровья. S · low. _maybe_trigger_self_test() при ≥3 docs + 6h cooldown. _(commit 6e6c700)\_
- [x] **P4-28** · style*bank · Сделать Style Bank полноценным пунктом меню. S · low. Nav item + rStyleBankPage() со статистикой. *(commit 6e6c700)\_

**Регресс Ф4:** `scripts/regression_screens.py` → 26/26 чисто. Тестовых записей нет. Аккаунты 9 ACTIVE + 1 INVALID. WARMING 0. P4-21 закрыт в Ф5 (P5-01).

---

## ФАЗА 5 — Сквозная инфраструктура

- [x] **P5-01** · Сквозное · `account_daily_usage` — персистентные суточные лимиты per-account с reset по дате, проверяемые всеми движками горячего пути. M · med. Таблица + core/daily*usage.py + подключено в dm/chat_broadcast/invite/join. Live: 6/6 unit ✓, endpoint ✓. *(commit 2b5a705)\_
- [x] **P5-02** · Сквозное · Общий `app/services/tg_runner.py` — единый build*proxy_kwargs (дедуп из 10 файлов, делегация). M · med. Live: 10/10 импорт ✓, воркер online, регресс 26/26. *(commit c97a359)\_
- [x] **P5-03** · Сквозное · `can_act(account, action_type)` поверх Настроек (лимиты+активные часы), применить в boost/stories/cloner и кампаниях. M · med. can*act() в core/daily_usage; boost+stories per-account; кампании — лимиты в P5-01; cloner — active-hours уже task-level (P2-08), per-account дневной лимит не применим (пишет в свой канал). Live: 5/5 unit ✓, регресс 26/26. *(commit 603d809)\_
- [x] **P5-04** · Сквозное · Beat-планировщик SCHEDULED/drip/AUTO*MONITOR (DM/broadcast/invite/boost/stories/cloner). M · med. pup_tg.campaign_scheduler (5мин): SCHEDULED→start, DM auto_paused active-hours→resume, AUTO_MONITOR stories→re-tick. Live: started+resumed ✓, manual PAUSED не тронут. *(commit aa9e4c8)\_
- [x] **P5-05** · Сквозное · Слой DM-ownership: Агент — единственный движок входящих ЛС. M · high. **РАЗБЛОКИРОВАН** владельцем (КОНСОЛИДАЦИЯ, явное разрешение трогать ai_agent). Карта: [ENGINE-CONSOLIDATION.md](ENGINE-CONSOLIDATION.md). Этап A — (commit 662fead).
  - [x] **B1** · single-ownership гейт: `app/services/dm_ownership.py` (`agent_owns_account_dms`/`any_active_dm_agent`); AI Sales monitor yield + `/start`/`/monitor`→409 при активном Агенте; auto-replier per-account yield. Live: `/monitor`→409 ✓, 7/7 unit ownership ✓, Atlas-цикл жив. (commit 4264ba6)
  - [x] **B2** · auto-replier → фронт-линия: `HANDOFF_SALES` больше не молчаливый no-op — логирует «[HANDOFF → AI Агент]» и НЕ помечает диалог прочитанным (остаётся Агенту/человеку, без параллельного ответа); tooltip + `connect_ai_sales`→«AI Агент». Данные auto-replier не трогали. (commit B2-B3)
  - [x] **B3** · AI Sales off-runtime: UI архив-баннер в `rAiSales` (скрипты/диалоги/воронка сохранены, рантайм остановлен); воронка-стадии → P6-09; `tg_sales_*` НЕ дропали (со-владение Агента). (commit B2-B3)
  - [x] **B4** · регресс `regression_screens.py` 26/26 ✓; `contract_smoke.py` ✓ (73 UI-эндпоинта); Atlas всё время ACTIVE (исходный статус). (commit B2-B3)
  - Отложено: **скриптовая воронка со стадиями** — единственная функция AI Sales без аналога в Агенте → **P6-09** (на проде 0 скриптов, данные сохранены).
- [x] **P5-06** · Сквозное · Единый источник enum`ов для фронта (отдавать через `/system`) — против рассинхронов. S · low. GET /system/enums + UI fetch в S.enums + drift-warning. Live: fetch ✓, in-sync ✓. _(commit 37b6386)_
- [x] **P5-07** · Сквозное · Контрактный smoke-тест UI→эндпоинты (ловить рассинхроны). M · low. scripts/contract*smoke.py: 73 UI-endpoint ⇄ OpenAPI. Нашёл дрейф /auto-replier/test (UI вызывал несуществующий) → добавил endpoint. Live: smoke pass, регресс 26/26. *(commit e5805a0)\_
- [x] **P5-08** · Сквозное · Единый аудит горячего пути (чек/спамблок/apply/send → tg*audit_logs). S · low. `app/core/audit.py::record_audit()` — единый sink (never-raises, не ломает горячий путь). Подключён: `account.check`/`account.spamblock` (accounts.py), `account.profile_apply` (account_profile.py), `send.dm`/`send.dm.flood`/`send.dm.error` (dm_campaign send-loop, observability-only, **анти-бан delay/sleep не тронуты — diff +16/-0**). Литеральный декоратор на эндпоинты НЕ применён: handlers под `from __future__ import annotations` (string-аннотации `-> SpamblockResult`), FastAPI резолвит их по `__globals__` хендлера — кросс-модульный wrapper это ломает (проверено), поэтому явные вызовы. Live: check-spamblock→502+audit-строка ✓, contract_smoke 194 routes ✓, signatures чистые, Atlas ACTIVE. *(commit P5-08)\_
- [x] **P5-09** · Сквозное · Унифицирована «непрерывность» воркеров (reaper/heartbeat). M · med. `app/core/continuity.py`: `touch_heartbeat()` + `revive_stale_loops()` (реестр `CONTINUITY_SPECS`). Beat `pup_tg.worker_continuity` (5мин) + kick на `worker_ready` оживляют commenting/auto*replier/boost/cloner, чьи петли умерли при рестарте воркера (по stale `last_tick_at`); живая петля держит heartbeat свежим → без двойного запуска. Heartbeat: commenting (per-account, чинит непрерывный мониторинг — раньше был one-shot), auto_replier (per-cycle), boost/cloner (orphan-recovery). Миграция `last_tick_at` на 4 таблицы. **stories AUTO_MONITOR и SCHEDULED-кампании уже покрыты `campaign_scheduler` (P5-04) — вне scope, чтобы не дублировать тики.** Live: миграция ✓ (4/4 колонки), reaper-логика 6/6 кейсов (stale/NULL→revive, fresh/recent/paused→skip, heartbeat-bump), `worker_continuity` на старте отработал без ошибок, Atlas жив. Live-проверка реального orphan-recovery ограничена (0 активных задач + нужен реальный рестарт воркера в проде). *(commit P5-09)\_

**Регресс Ф5:** `regression_screens.py` → 26/26 чисто; `contract_smoke.py` → 73 UI-эндпоинта ⇄ 194 OpenAPI ✓. Тестовых записей нет (синтетика reaper-теста — in-memory, прод не тронут). Аккаунты 9 ACTIVE + 1 INVALID; Atlas ACTIVE; активных задач воркеров 0. **Фаза 5 закрыта (9/9).** Дальше — Phase 6.

---

## ФАЗА 6 — Крупные/стратегические (L, med+)

- [x] **P6-01** · kb / все AI · Гибридный (keyword + векторный) поиск поверх колонки `embedding` (fastembed). L · med. `app/ai/embeddings.py` — ленивый локальный провайдер (fastembed, модель `paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, RU+EN), float32-BLOB, cosine, graceful-fallback (нет модели → keyword). `app/services/kb_search.py::hybrid_retrieve()` — единая retrieval (0.5·cosine + 0.5·keyword; doc-scoped → полный пул, global → keyword-кандидаты + vec-rerank). Подключено: ai*agent `_search_kb_chunks`, ai_sales `_search_rag_chunks`, KB `_retrieve_chunks` (/kb/search, /kb/chat). Эмбеддинги генерятся при создании чанка (best-effort) + backfill `POST /kb/reembed`. requirements: fastembed==0.8.0, numpy==2.4.6. Live: модель грузится ✓; reembed 109/109 чанков (1536 B=384×f32) ✓; `/kb/search` mode=hybrid отдаёт релевантное (вкл. кросс-язычный EN→RU) ✓; изолированный cosine 0.34 (релевант) vs −0.05 (нерелевант) ✓; contract_smoke 195 ✓; regression 26/26 ✓; Atlas ACTIVE, без ошибок. Live в воркере: модель грузится лениво при первом KB-вызове агента (тот же проверенный код-путь; на момент теста чаты Atlas молчали — отметка). *(commit P6-01)\_
- [x] **P6-02** · messenger · Отправка медиа + просмотр вложений (download*media/send_file). L · med. Бэкенд: `GET /telegram/{acc}/messages/{peer}/{msg_id}/media` (download_media→Response с реальным mime+filename, 404 для не-скачиваемого, 413 cap 50MB) + `POST /telegram/{acc}/send-media` (multipart UploadFile + caption/reply_to/force_document → send_file). Хелперы `_find_peer_entity` (дедуп резолва пира) + `_media_filename_mime`. UI (мессенджер): 📎-кнопка + hidden file-input → `msgSendMedia` (FormData), скачиваемые вложения кликабельны → `msgOpenMedia` (header-authed blob → new tab). Live: empty→400, нет peer_id→422, download→502 NO_PROXY (connect-guard работает) ✓; contract_smoke 197 ✓; regression 26/26 ✓; Atlas ACTIVE. Реальный media round-trip (send_file/download реального файла) live-ограничен — у аккаунтов в dev нет активного прокси (NO_PROXY-guard), как и в прочих TG-client задачах. *(commit P6-02)\_
- [x] **P6-03** · messenger · Переиспользование клиента + кеш entity (вместо reconnect). M · med. `app/telegram/messenger_pool.py`: кеш подключённого клиента per-account (reuse между запросами, lazy idle-eviction `_IDLE_TTL`=300s, liveness-check+rebuild при разрыве, per-account asyncio-lock) + кеш resolved-entity per (account,peer) `_ENTITY_TTL`=600s (на miss — dialog-scan/resolve, потом из кеша — без `get_dialogs(100)` каждый раз). На in-memory StringSession из `client_pool._load_account` (без tmp-session-файлов). Все 7 messenger-эндпоинтов (dialogs/messages/send/send-media/media-download/mark-read/sessions) переведены: `get_messenger_client` + `resolve_entity`, finally больше НЕ дисконнектит (кеш владеет lifecycle). NO*PROXY-guard и семантика 404/502 сохранены. `_connect_account_telethon` помечен DEPRECATED (вне hot-path). Live: NO_PROXY→502 на всех 4 connect-эндпоинтах ✓; изолированные unit-кейсы кеша 7/7 (reuse=1 connect/2 запроса, dead→rebuild, idle-evict, NO_PROXY 502, 404, entity-cache 1 resolve/peer) ✓; contract_smoke 197 ✓; regression 26/26 ✓; Atlas ACTIVE без ошибок. Реальный reuse с подключённым аккаунтом live-ограничен (нет активного прокси в dev). *(commit P6-03)\_
- [x] **P6-04** · messenger · Удаление/редактирование/пересылка. M · med. На инфре P6-03 (`get_messenger_client`+`resolve_entity`). Бэкенд: `PATCH /telegram/{acc}/messages/{peer}/{msg_id}` (edit*message, MessageNotModified→not_modified), `POST .../messages/{peer}/delete` (delete_messages, revoke=for-everyone, min 1 id), `POST .../messages/forward` (forward_messages from→to). UI (мессенджер): на каждом сообщении действия ✏️(edit own non-media)/↪(forward→prompt @username)/🗑(delete); `msgApi` (PATCH/DELETE/POST helper). NO_PROXY-guard + 404/422/429/502 сохранены. Live: edit/delete/forward → 502 NO_PROXY (connect-guard) ✓, пустой message_ids→422, forward без полей→422 ✓; contract_smoke ✓; regression 26/26 ✓; Atlas ACTIVE. Реальный round-trip live-ограничен (нет прокси в dev). *(commit P6-04)\_
- [x] **P6-05** · messenger · Глобальный поиск + resolve по @username. M · low-med. На инфре P6-03. Бэкенд: `GET /telegram/{acc}/resolve?username=` (get*entity → {id,title,type,username,access_hash}, принимает @name/name/t.me-ссылку, 404 если не найдено) + `GET /telegram/{acc}/search?q=&limit=` (SearchGlobalRequest, telethon 1.37; маппит users/chats→имена, отдаёт message_id/peer_id/peer_title/snippet/date). Хелпер `_peer_to_id`. UI (мессенджер): поле «@username / глоб. поиск» + кнопки `@→` (открыть чат по @username) и `🌐` (глоб. поиск → результаты в списке диалогов, клик открывает чат); Enter = поиск. NO_PROXY-guard + 422/502 сохранены. Live: resolve/search без аргумента→422, с аргументом→502 NO_PROXY ✓; contract_smoke 202 ✓; regression 26/26 ✓; Atlas ACTIVE. Реальный resolve/поиск live-ограничен (нет прокси в dev). *(commit P6-05)\_
- [x] **P6-06** · account*profile · Bulk-генерация и применение профилей по пулу. L · med-high. `app/tasks/profile_tasks.py` (Celery, т.к. Claude-вызов блокирующий, а apply пейсится): `pup_tg.bulk_generate_profiles` (генерит identity + опц. аватар на пул, сохраняет локально как DRAFT, TG не трогает) и `pup_tg.bulk_apply_profiles` (пушит сохранённые профили в реальные TG-аккаунты, рандомная пауза 5-15с между аккаунтами, NO_PROXY-guard per-account). **Переиспользует напрямую** `generate_identity`/`generate_avatar`/`apply_profile` (DI-маркеры игнорятся при прямом вызове — без дублей и без рефактора рабочих эндпоинтов). Эндпоинты `POST /accounts/profiles/bulk-generate` + `/bulk-apply` (202, dispatch). UI: на экране Аккаунты активирована кнопка «👤 Профиль» в bulk-баре → модалка (пол/ниша/аватар + «Сгенерировать» / «Применить к TG»). Live: **реальный bulk-generate на 2 акк → 2/2 сгенерированы** (имя/username/bio, country-derived RU+GR; аккаунты восстановлены из снапшота); bulk-apply: bad part→400, dispatch→202, в воркере per-account NO_PROXY + анти-бан-пауза ✓; contract_smoke 204 ✓; regression 26/26 ✓; Atlas ACTIVE. Реальный bulk-apply round-trip live-ограничен (нет прокси в dev). *(commit P6-06)\_
- [x] **P6-07** · accounts · Авто-чек по расписанию (Celery) + история здоровья (timeline). M · med. Таблица `tg_account_health_history` (schema.sql + idempotent-миграция database.py). `check_telegram` разделён на тонкий эндпоинт + `_check_telegram_impl` (ядро) — эндпоинт пишет результат в таймлайн (`_record_health_history`, source=manual). Beat `pup_tg.account_health_check` (каждые 6ч): чекает ACTIVE/WARMING/FLOOD*WAIT/SPAM_BLOCKED-аккаунты (переиспользует `_check_telegram_impl`), пишет в таймлайн (source=scheduled), анти-бан-пауза 3-8с между аккаунтами, NO_PROXY без коннекта; не дублирует тики membership_check/worker_continuity/campaign_scheduler (другая работа). API `GET /accounts/{id}/health-history`. UI: вкладка «Здоровье» в детали аккаунта (таймлайн: дата/статус/флаги/humanity/источник + «⟳ Проверить сейчас»). Live: миграция ✓; ручной чек→строка (manual) ✓; beat через filesystem-broker→**8 scheduled-строк** (paced, NO_PROXY) ✓; timeline API ✓; beat зарегистрирован в расписании ✓; тестовые health-строки подчищены; contract_smoke 205 ✓; regression 26/26 ✓; Atlas ACTIVE. Реальный live-чек подключённых аккаунтов ограничен (нет прокси в dev) — в dev пишется NO_PROXY. *(commit P6-07)\_
- [x] **P6-08** · proxies · Настоящая проверка (auth + Telegram DC) + гео/IP-обогащение. M · med. `/{id}/check` и `/check-all` переведены с plain-TCP на **реальную проверку через прокси**: `_check_proxy_real` коннектится ЧЕРЕЗ прокси (python*socks, auth-handshake) к Telegram DC (149.154.167.51/175.50/91.108.56.130:443) — проверяет и креды, и доступность DC; меряет latency. `_proxy_egress_geo` — best-effort egress IP+гео через прокси (ip-api.com): пишет в `metadata.geo` (egress_ip/country/city/isp) + backfill пустых `country`/`city`. `_persist_proxy_check` — единый persist (status ACTIVE/DEAD + latency + гео). Переиспользует поля status/last_checked_at/last_latency_ms/metadata; новый beat НЕ добавлял (P3-06 EXPIRED — отдельная задача, без дублей). Live (реальные прокси в dev): `/check` → ACTIVE 408ms + гео (188.208.126.164, Moldova/Chisinau, Moldtelecom) ✓; `/check-all` → 3 ACTIVE (160-653ms, гео) + 1 fake (1.2.3.4) → DEAD с понятной ошибкой ✓; гео персистится в metadata+колонки ✓. Прокси восстановлены из снапшота в исходный статус. contract_smoke 205 ✓; regression 26/26 ✓; Atlas ACTIVE. *(commit P6-08)\_
- [x] **P6-09** · ai-sales/ai-agent · Перенос скриптовой воронки со стадиями в AI Агента. M · med. Карта — [ENGINE-CONSOLIDATION.md#P6-09] (commit 8e066ba).
  - [x] **B1** миграции `tg_ai_personas.funnel_script_id` + `tg_dm_threads.funnel_stage` (идемпотентно) + порт чистых хелперов `_funnel_get_stages/_advance/_is_terminal/_stage_section` в ai*agent_tasks (без импорта off-runtime ai_sales). *(commit 809dcf0)\_
  - [x] **B2** встроено в `_handle_secretary_dm` (opt-in по `persona.funnel_script_id`): стадия в `tg_dm_threads.funnel_stage`, advance по `advance_keywords`, инжект цели стадии (+ script.system*prompt) в промпт, лог терминала. Persona API: `funnel_script_id` на create/update. Источник скрипта — существующие `tg_sales_scripts` (новой таблицы нет). NULL-привязка → поведение секретаря 1:1. *(commit 7a190ef)\_
  - [x] **B3** метрики `/ai-promoter/personas/{id}/funnel-stats` (распределение по стадиям + конверсия по терминалам) + UI: дропдаун воронки-скрипта в редакторе персоны + строка статов. _(commit B3)_
  - НЕ дублирован поллер входящих (стадии внутри единственного владельца ЛС); чаты/комментинг/KB-RAG/cold-outreach не тронуты; `tg_sales_*` сохранены (на проде 0 скриптов).
  - Live: миграции 2/2 ✓; funnel-хелперы 7/7 unit ✓; создан тест-скрипт + привязка к Atlas round-trip через API ✓; `/funnel-stats` отдал стадии/конверсию ✓; Atlas ACTIVE без import/traceback при активной привязке (0 ошибок), loop*token-guard ОК (без двойного revive). Реальный staged-ответ нужен TG-инбаунд → **live-ограничен** (в dev инбаунда нет) — проверено логикой/хелперами/гейтами. Тест-скрипт удалён, Atlas разбинжен в исходный статус. contract_smoke 206 ✓; regression 26/26 ✓. *(commit B3)\_
- [x] **P6-10** · arena · Харвест корпуса → Style Bank + live-просмотр. L · med-high. `POST /arenas/{id}/harvest` — собирает удачные реплики арены (tg*ai_messages с arena_id, status=SENT; `only_rated`→только 👍) через **переиспользование** Style Bank-синка и фильтров (`clean_text`/`is_good_line`) + тот же 2-turn snippet-формат, что `/style/paste`; дедуп против уже собранных arena-сэмплов по теме; бампит `tg_agent_arenas.total_harvested`. `GET /arenas/{id}/messages` — live-просмотр реплик. UI: на строке арены кнопки 📚 (харвест в Стиль-банк, тема из арены) + 👁 (просмотр сообщений); колонка «В корпус» уже была. Анти-бан арены (cadence/loop_token) — существующий, не трогали. Новых таблиц нет (Style Bank из P4-28, экспорт-паттерн из P3-20). Live: синтет. арена (4 SENT-сообщения) → harvest 3 сниппета (тема=крипта), повторный harvest 0 (дедуп ✓), `/messages`=4 ✓; тест-данные удалены (Style Bank → 2000 как было, 0 арен). Реальный харвест self-play live-ограничен (в dev арена не гоняла реплики — нужен прокси+группа). *(commit P6-10)\_
- [x] **P6-11** · neuro-commenting · Очередь модерации (approve/reject) + RAG/Style в комментах. M · med. Очередь: PENDING-строки `tg_commenting_log` (хранилище уже было — approval*mode ALL/IMPORTANT) + новые `GET /commenting/queue`, `POST /commenting/queue/{id}/approve` (коннект через `get_client_for_account` NO_PROXY-guard → отправка коммента `comment_to=post_id` → SENT), `/reject` (→REJECTED, 409 если не PENDING). RAG/Style в генерации воркера: гибридный `kb_search.hybrid_retrieve` (P6-01) по тексту поста + `_comment_style_examples` из Style Bank (`tg_style_samples`, P4-28/P6-10) инжектятся в промпт (try/except — не ломает генерацию). Переиспользована commenting-инфра + dedup-лог (P4-25), новых таблиц нет. UI: кнопка «🛡 Модерация» в нейрокомментинге → модалка с approve/reject. Live: queue list 2 PENDING ✓, reject→REJECTED + 409 на повтор ✓, approve→502 NO_PROXY (send live-ограничен, коммент корректно остаётся PENDING) ✓; style-helper 3 примера из 2000, hybrid_retrieve выполняется ✓; тест-данные удалены; contract_smoke 211 ✓; regression 26/26 ✓; Atlas ACTIVE, 0 ошибок. ai_agent не трогали. *(commit P6-11)\_

**Регресс Ф6:** `regression_screens.py` → 26/26 чисто; `contract_smoke.py` → чисто (211 routes). Тестовые записи удалены (синтетика P6-06/07/10/11). Аккаунты 9 ACTIVE + 1 INVALID; прокси 4 ACTIVE; Atlas ACTIVE (funnel=none, исходный статус); Style Bank 2000; 0 арен. tg*sales*\* сохранены. **Фаза 6 закрыта (11/11) — все 92 задачи плана выполнены.**

---

## BLOCKED (вопросы, требующие продуктового решения)

_(пусто — пополняется по ходу)_

---

## Журнал выполнения

- Старт плана: база `fd240e1`.
- **ФАЗА 1 завершена (12/12)** — commits P1-01..P1-12. Регресс 26/26 чисто, тестовые записи удалены (вкл. 3 старые test-аудитории), аккаунты 9 ACTIVE + 1 INVALID (без изменений), зависших WARMING нет. Следующий заход начинает с ФАЗЫ 2 (P2-01).
- **ФАЗА 2 частично (7/11)** — commits P2-01..P2-07. Закрыты фантомные config-поля DM (фильтры/active_hours/distribution), chat-broadcast (exclude/gap_24h/posts_per_day/ban_auto_stop/slow_mode/distribution), inviting (filter_premium/ai_score/privacy_threshold), boost+stories (active-hours gate). Checkpoint-регресс 26/26 чисто; Atlas-персона возвращена в ACTIVE (временно ставилась PAUSED для чистоты live-тестов); тестовых записей нет; аккаунты 9 ACTIVE + 1 INVALID; WARMING 0.
  - **ФАЗА 2 завершена (11/11)** — commits P2-01..P2-11. Регресс 26/26 чисто; тестовых записей нет (вкл. подчищенные m4-h3-recheck/m4-rotation/t3-503); аккаунты 9 ACTIVE + 1 INVALID; WARMING 0; settings/extra_settings восстановлены; Atlas → ACTIVE. Отложено: **P2-10b** (ai_agent hot-path notify). Следующий заход — **ФАЗА 3 (P3-01)**.
  - **ФАЗА 3 частично (3/21)** — commits P3-01..P3-03 (accounts health-фильтр; custom-avatar upload + seeded fallback; profile preview). Чекпоинт-регресс 26/26 чисто; Atlas ACTIVE; аккаунты 9 ACTIVE + 1 INVALID; тестовых записей нет. **Резюме-точка: P3-04** (pre-check username через CheckUsername — нужен телеграм-клиент, live-тест ограничен). Дальше P3-05 proxy import-форматы (бэкенд, изолированно), P3-06 beat авто-EXPIRED, P3-07..09 dashboard (один файл), и т.д.
  - ⚠️ Для live-тестов воркера: Atlas-персона (ACTIVE) сильно загружает воркер (циклы по 192с, прокси в dev недоступен). На время тестов её можно временно ставить PAUSED и обязательно возвращать в ACTIVE. Рестарт воркера — только `./scripts/dev-down.sh` + kill celery, иначе старый код висит (порт 8001 = только API).
