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

| Фаза      | Тема                                            | Задач  | Статус |
| --------- | ----------------------------------------------- | ------ | ------ |
| 1         | Починка сломанного + безопасность               | 12     | ☐      |
| 2         | «Фантомные» config-поля (подключить или скрыть) | 11     | ☐      |
| 3         | Quick wins по разделам (S/low)                  | 21     | ☐      |
| 4         | Средние улучшения (M, low-med)                  | 28     | ☐      |
| 5         | Сквозная инфраструктура (общие компоненты)      | 9      | ☐      |
| 6         | Крупные/стратегические (L, med+)                | 11     | ☐      |
| **Итого** |                                                 | **92** |        |

---

## ФАЗА 1 — Починка сломанного + безопасность

Делаем ПЕРВОЙ. Всё, что «UI дёргает несуществующее / падает 400/422 / показывает 0 / течёт секрет / ложная отчётность».

- [x] **P1-01** · settings · Замаскировать `anthropic_api_key` (+`telegram_app_hash`) в `GET /settings` (`sk-a…wwAA`); PATCH дропает маск-значения → не затирает ключ. Live ✓. _(commit P1-01)_
- [x] **P1-02** · ai-sales · Добавлен `GET /ai-sales/knowledge-base` (read-only вид над tg*kb_documents, shape `{items}`). Live: 2 дока ✓. *(commit P1-02)\_
- [x] **P1-03** · parser · UI-режимы синхронизированы с VALID*MODES (8 реальных). Live: REACTIONS→201, ACTIVE_ONLINE→400 ✓. *(commit P1-03/04)\_
- [x] **P1-04** · parser · found*count/filtered_count → total_found/total_filtered (3 места в rParser). Live: поля присутствуют ✓. *(commit P1-03/04)\_
- [x] **P1-05** · channels · Тип→{CHANNEL,SUPERGROUP,BASIC*GROUP,FORUM}, роль→{SOURCE,TARGET,BOTH,NONE}, чекбокс «мой канал»→is_own, вкладки/бейджи переведены на is_own+BOTH, resolve-маппинг типов. Live: SUPERGROUP/BOTH/is_own→201, 'channel'→400 ✓. *(commit P1-05)\_
- [x] **P1-06** · auto-replier · UI-поведения → AI*REPLY/TEMPLATE/SILENCE/NOTIFY/HANDOFF_SALES + tooltip. Live: NOTIFY→201, FORWARD→400 ✓. *(commit P1-06/07)\_
- [x] **P1-07** · phone-checker · `b.total` → `b.input_count` (фолбэк на total). Совпадает со схемой бэка ✓. _(commit P1-06/07)_
- [x] **P1-08** · converter · POST /converter/tasks теперь multipart (files+direction+options); `_parse_direction` → input/output*format, файлы сохраняются в data/converter/<id>/, files_count проставляется; UI «Старт» показывается и для DRAFT. Live: 201 (file сохранён), foo_bar→400 ✓. Реальная конвертация — P4-11. *(commit P1-08)\_
- [x] **P1-09** · settings · Бридж UI↔колонки: `_ALIAS_TO_COL` (ai*model, daily*_, app_id/hash, notif_emergency_stop/spam_block, emergency/flood), active_hours_start/end↔active_hours, неизвестные UI-поля → новая колонка `extra_settings` (JSON). GET эхо-ит алиасы. Schema+ALTER ws-_.db. Live: PATCH UI-payload персистится (колонки+extra), ключ цел, restored ✓. _(commit P1-09)_
- [ ] **P1-10** · inviting · Режим INVITE_LINK логирует ложный `SUCCESS`, ничего не отправив. Честно помечать (NOT_SENT/SKIPPED) или задизейблить режим в UI с пометкой. S-M · med (ложная отчётность)
- [ ] **P1-11** · ai-promoter · Удалить/задепрекейтить мёртвый `ai_promoter_tasks.py` (`pup_tg.ai_promoter`, нигде не диспатчится, баг `account_id`). S · low
- [ ] **P1-12** · warmup · Подключить мок-экран `rWarmup` к реальному `/warmup/status` + `/warmup/log/{id}` + кнопки start/stop (убрать хардкод-номера). M · low (бэк готов, чистый фронт)

**Регресс Ф1:** `scripts/regression_screens.py` → 26/26, чистка тестовых записей.

---

## ФАЗА 2 — «Фантомные» config-поля

Для каждого поля, которое форма собирает, а воркер игнорирует: **подключить** (если S) либо **задизейблить/скрыть в UI** с пометкой «не реализовано» (чтобы не было мнимой защиты). Решение по каждому — фиксировать прямо в задаче.

- [ ] **P2-01** · dm-campaign · Подключить к воркеру active_hours + filter_online/username/ai_score_min + exclude_audience_id + skip_list + max_per_day (фильтрация получателей и активные часы). M · med
- [ ] **P2-02** · dm-campaign · distribution (ROUND_ROBIN/GEO/RANDOM) — round-robin ротация аккаунтов вместо последовательного исчерпания. M · med
- [ ] **P2-03** · chat-broadcast · Подключить exclude_channels + gap_24h (не постить в один чат чаще раза/сутки) + posts_per_day + ban_auto_stop. M · med
- [ ] **P2-04** · chat-broadcast · slow_mode_behavior + distribution — применить в воркере. S-M · med
- [ ] **P2-05** · inviting · Подключить filter_premium/online/ai_score_min + privacy_threshold (авто-стоп при высоком % privacy) + flood_behavior. M · med
- [ ] **P2-06** · boost · Уважение дневных лимитов из `tg_settings` (limits\_\*\_per_day) + активные часы перед каждым действием. M · med
- [ ] **P2-07** · stories-boost · Лимиты + активные часы из настроек. S · low
- [ ] **P2-08** · cloner · Воркер копирует только posts: подключить profile/avatar/pinned + replacements + max_posts_per_day + active_hours. M · med
- [ ] **P2-09** · channel-creator · Реализовать username_pattern (UpdateUsername) + permissions (EditChatDefaultBannedRights) + аватар/описание (иначе «голый» канал). M · low
- [ ] **P2-10** · settings · Реальная привязка `notify_on_*`/`notif_*` к отправке в TG-бот (notification.service). S · low
- [ ] **P2-11** · Сквозное · Зафиксировать в этом файле итог аудита «UI-поле → читается воркером»: что подключено, что скрыто. S · low

**Регресс Ф2:** полный прогон + чистка.

---

## ФАЗА 3 — Quick wins по разделам (S, low risk)

- [ ] **P3-01** · accounts · Колонка + фильтр по «здоровью» (humanity/restricted/scam уже в ответе). S · low
- [ ] **P3-02** · account_profile · Загрузка своего аватара (upload) + seed/несколько источников. S · low
- [ ] **P3-03** · account_profile · Предпросмотр «как увидят аккаунт» перед apply. S · low
- [ ] **P3-04** · account_profile · Pre-check занятости username (CheckUsername) до apply. S · low-med
- [ ] **P3-05** · proxies · Расширенные форматы импорта (socks5://user:pass@host:port, rotation_url). S · low
- [ ] **P3-06** · proxies · Beat-задача авто-EXPIRED для истёкших + бейдж. S · low
- [ ] **P3-07** · dashboard · Полнота словарей статусов/типов (INVALID, ISP). S · low
- [ ] **P3-08** · dashboard · Виджеты парсера/чекера/аудиторий (найдено за месяц, размер баз). S · low
- [ ] **P3-09** · dashboard · Кэш агрегата 15-30с. S · low
- [ ] **P3-10** · parser · Авто-поллинг прогресса RUNNING-задач. S · low
- [ ] **P3-11** · parser · Пауза/возобновление в UI (бэк умеет PAUSED→start). S · low
- [ ] **P3-12** · parser · Выбор существующей аудитории + premium_only в UI-модалке. S · low
- [ ] **P3-13** · audiences · Кнопка экспорта/скачивания (CSV/JSON, бэк /export готов). S · low
- [ ] **P3-14** · audiences · Фильтры/поиск + пагинация в детальной странице. S · low
- [ ] **P3-15** · channels · Инлайн-редактирование роли/категории (PATCH готов). S · low
- [ ] **P3-16** · channels · Сохранять about/members_count при resolve→POST. S · low
- [ ] **P3-17** · channels · Кнопка «Спарсить» из строки канала (→parser). S · low
- [ ] **P3-18** · phone-checker · Сохранение найденных в аудиторию. S · low
- [ ] **P3-19** · phone-checker · Импорт номеров из файла + экспорт результатов. S · low
- [ ] **P3-20** · ai-promoter · Экспорт 👍-реплик в Style Bank/Arena-корпус. S · low
- [ ] **P3-21** · style_bank · Привязка topic стиль-банка к персоне (поле в персоне). S · low

**Регресс Ф3:** полный прогон + чистка.

---

## ФАЗА 4 — Средние улучшения (M, low-med)

- [ ] **P4-01** · warmup · Bulk-старт/стоп прогрева на экране (выбор пачки аккаунтов). S · low
- [ ] **P4-02** · warmup · Уведомление «аккаунт прогрет» (notif_warmup_ready). S · low
- [ ] **P4-03** · warmup · График прогресса по дням из логов. S · low
- [ ] **P4-04** · warmup_scripts · Создать UI-экран (конструктор + история run'ов; бэк готов). M · low
- [ ] **P4-05** · warmup_scripts · Объединить со «Прогрев» как вкладку. S · low
- [ ] **P4-06** · stories-boost · Авто-определение последней сторис (GetPeerStories). S · low
- [ ] **P4-07** · boost · Ротация аккаунтов по здоровью + round-robin. S · low
- [ ] **P4-08** · boost · Множественные эмодзи с весами для реакций. S · low
- [ ] **P4-09** · cloner · Дедуп/докопирование (курсор last_cloned_id). S · low
- [ ] **P4-10** · cloner · Фильтры контента (пропуск рекламы/по ключевым словам). S · low
- [ ] **P4-11** · converter · Скачивание результата (AES-расшифровка in-memory) + audit. S · med
- [ ] **P4-12** · converter · Страна по номеру + проверка живости после конвертации. S · low
- [ ] **P4-13** · join-chats · Дневной лимит вступлений per-account. S · med
- [ ] **P4-14** · join-chats · Авто-стоп при серии BANNED_AFTER_JOIN. S · low
- [ ] **P4-15** · join-chats · Retry проблемных (FAILED) чатов. S · low
- [ ] **P4-16** · channel-creator · Распределение создания по нескольким аккаунтам (round-robin). M · med
- [ ] **P4-17** · channel-creator · Лимит создания per-account + ramp-up. S · med
- [ ] **P4-18** · channel-creator · Инкрементальный прогресс created_count. S · low
- [ ] **P4-19** · channel-creator · Авто-связка is_own каналов как target (инвайтинг/boost). S · low
- [ ] **P4-20** · dm-campaign · Детект ответов (REPLIED) + конверсия (мёртвая метрика). M · low
- [ ] **P4-21** · dm-campaign · Дневной лимит между запусками (account_daily_usage). S · med (см. P5)
- [ ] **P4-22** · chat-broadcast · Детект удаления постов модерами (survival_rate). M · low
- [ ] **P4-23** · chat-broadcast · Пауза/резюм + PATCH (симметрия с DM). S · low
- [ ] **P4-24** · inviting · Пауза/резюм. S · low
- [ ] **P4-25** · neuro-commenting · Дедуп/история откомментированных постов + лог в UI. S · low
- [ ] **P4-26** · templates · AI-генерация вариантов (ai_personalization-флаг). S · low
- [ ] **P4-27** · kb · Авто-self-test/conflict-check после upload + бейдж здоровья. S · low
- [ ] **P4-28** · style_bank · Сделать Style Bank полноценным пунктом меню. S · low

**Регресс Ф4:** полный прогон + чистка.

---

## ФАЗА 5 — Сквозная инфраструктура

- [ ] **P5-01** · Сквозное · `account_daily_usage` — персистентные суточные лимиты per-account с reset по дате, проверяемые всеми движками горячего пути. M · med
- [ ] **P5-02** · Сквозное · Общий `app/services/tg_runner.py` — единый connect/proxy_kwargs/NO_PROXY-guard/FloodWait/ramp-up (дедуп из 6+ файлов). M · med
- [ ] **P5-03** · Сквозное · `can_act(account, action_type)` поверх Настроек (лимиты+активные часы), применить в boost/stories/cloner и кампаниях. M · med
- [ ] **P5-04** · Сквозное · Beat-планировщик SCHEDULED/drip/AUTO_MONITOR (DM/broadcast/invite/boost/stories/cloner). M · med
- [ ] **P5-05** · Сквозное · Слой DM-ownership (один обработчик на account+peer): развести ai_agent DM-секретарь / auto_replier / ai_sales. M · high
- [ ] **P5-06** · Сквозное · Единый источник enum'ов для фронта (отдавать через `/system`) — против рассинхронов. S · low
- [ ] **P5-07** · Сквозное · Контрактный smoke-тест UI→эндпоинты (ловить рассинхроны). M · low
- [ ] **P5-08** · Сквозное · Единый декоратор аудита на горячий путь (чек/спамблок/apply/send в tg_audit_logs). S · low
- [ ] **P5-09** · Сквозное · Унифицировать «непрерывность» воркеров (reaper/self-reschedule для commenting/auto_replier/boost/stories/cloner). M · med

**Регресс Ф5:** полный прогон + чистка.

---

## ФАЗА 6 — Крупные/стратегические (L, med+)

- [ ] **P6-01** · kb / все AI · Векторный (гибридный) поиск поверх колонки `embedding` (fastembed). L · med
- [ ] **P6-02** · messenger · Отправка медиа + просмотр вложений (download_media/send_file). L · med
- [ ] **P6-03** · messenger · Переиспользование клиента + кеш entity (вместо reconnect). M · med
- [ ] **P6-04** · messenger · Удаление/редактирование/пересылка. M · med
- [ ] **P6-05** · messenger · Глобальный поиск + resolve по @username. M · low-med
- [ ] **P6-06** · account_profile · Bulk-генерация и применение профилей по пулу. L · med-high
- [ ] **P6-07** · accounts · Авто-чек по расписанию (Celery) + история здоровья (timeline). M · med
- [ ] **P6-08** · proxies · Настоящая проверка (auth + Telegram DC) + гео/IP-обогащение. M · med
- [ ] **P6-09** · ai-sales · Привязка скрипта к аккаунтам/сегментам + конструктор воронки + метрики drop-off. M · med
- [ ] **P6-10** · arena · Харвест корпуса → Style Bank + анти-бан + live-просмотр. L · med-high
- [ ] **P6-11** · neuro-commenting · Очередь модерации (approve/reject) + RAG/Style в комментах. M · med

**Регресс Ф6:** полный прогон + чистка.

---

## BLOCKED (вопросы, требующие продуктового решения)

_(пусто — пополняется по ходу)_

---

## Журнал выполнения

- Старт плана: база `fd240e1`.
