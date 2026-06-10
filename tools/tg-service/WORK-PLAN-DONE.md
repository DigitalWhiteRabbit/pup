# TG Service · WORK-PLAN-DONE (архив закрытых фаз)

> Перенесено из WORK-PLAN.md после закрытия Phase 1 и Phase 2.
> Активный план — см. WORK-PLAN.md.

---

## ФАЗА 1 — Починка сломанного + безопасность ✅ 12/12

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
- [x] **P1-10** · inviting · INVITE*LINK больше не пишет ложный SUCCESS: результат `LINK_READY`, total_success не инкрементится; UI-tooltip честно поясняет (доставка ссылки — вручную/через ЛС). Syntax+worker-reload ✓ (полный live-инвайт отложен: нужны реальные аккаунты+группа, ban-risk). *(commit P1-10)\_
- [x] **P1-11** · ai-promoter · Удалён мёртвый `ai_promoter_tasks.py` + его регистрация в celery*app. Реальный движок `pup_tg.ai_agent` цел и работает (live в логах воркера). Worker рестарт без ошибок ✓. *(commit P1-11)\_
- [x] **P1-12** · warmup · `rWarmup` переписан на реальные `/warmup/status` + `/accounts`; убраны хардкод-номера; таблица из живых данных + Стоп по строке + «Запустить прогрев» (мульти-пикер аккаунтов, частично закрывает P4-01) + refresh. Live: playwright без ошибок (10 eligible), start→status→stop на disposable-акке ✓. _(commit P1-12)_

**Регресс Ф1:** `scripts/regression_screens.py` → 26/26, чистка тестовых записей.

---

## ФАЗА 2 — «Фантомные» config-поля ✅ 11/11

Для каждого поля, которое форма собирает, а воркер игнорирует: **подключить** (если S) либо **задизейблить/скрыть в UI** с пометкой «не реализовано» (чтобы не было мнимой защиты). Решение по каждому — фиксировать прямо в задаче.

- [x] **P2-01** · dm-campaign · Воркер теперь чтит: active*hours (вне окна → PAUSED), filter_username, filter_ai_score_min, exclude_audience_id, skip_list (дедуп по всем кампаниям), max_per_day (cap на base_limit). `filter_online` задизейблен в UI (нет данных онлайн-статуса в аудитории). Live: A→PAUSED (dm_outside_active_hours), B total_recipients 3→2 (filter_username), 0 реальных DMs (fake-acc). *(commit P2-01)\_
- [x] **P2-02** · dm-campaign · Воркер читает `distribution`: RANDOM → shuffle порядка аккаунтов; ROUND*ROBIN → последовательная ротация (каждый акк независимо ограничен effective_limit, перегруза нет); GEO_MATCHED → требует гео прокси (P6-08), пока = ROUND_ROBIN (отмечено в UI-tooltip). Полный message-level interleave (мульти-клиент) отложен как hot-path рерайт. Live: dm_distribution mode=RANDOM accounts=3, 0 DMs. *(commit P2-02)\_
- [x] **P2-03** · chat-broadcast · Воркер чтит exclude*channels (фильтр целей), gap_24h (дроп каналов с постом за 24ч по всем рассылкам), posts_per_day (cap на daily_limit), ban_auto_stop (вкл/выкл аварийный стоп по бан-ratio). Live: chatbr_channels_filtered total=3 remaining=2 excluded=1, 0 постов (fake-acc). *(commit P2-03)\_
- [x] **P2-04** · chat-broadcast · slow*mode_behavior (wait→sleep&retry если ≤300с, next_account→отдать канал след.акку, skip→как раньше) + distribution (round_robin → shuffle аккаунтов). Live: chatbr_distribution mode=round_robin, 0 постов (fake-acc). slow_mode live-триггер невозможен без реального slow-mode канала — логика в коде. *(commit P2-04)\_
- [x] **P2-05** · inviting · Воркер чтит filter*premium + filter_ai_score_min (фильтр получателей) + privacy_threshold (авто-стоп EMERGENCY_STOPPED при доле privacy-restricted > порога, после ≥10 попыток). filter_online задизейблен в UI (нет данных). flood_behavior уже покрыт существующим PeerFlood→FLOOD_WAIT + глобальными настройками (per-campaign override не добавлял — низкая ценность/риск). Live: invite_recipients_filtered count=1 (premium AND score≥0.5 из 3), 0 attempts. *(commit P2-05)\_
- [x] **P2-06** · boost · Active-hours gate: `_settings_active_now(db)` (parsing settings.active*hours) — вне окна boost_task → PAUSED. Live: PAUSED + boost_outside_active_hours (active_hours=00-05, час 16). Дневной per-account лимит: каждый акк делает ≤1 действие/run, настоящие суточные счётчики — P5-01 (account_daily_usage). *(commit P2-06/07)\_
- [x] **P2-07** · stories-boost · Тот же active-hours gate в stories*boost → PAUSED. Live: stories_outside_active_hours ✓. *(commit P2-06/07)\_
  - ⚠️ Наблюдение (вне аудита, pre-existing): boost+stories при одновременном запуске ловят Telethon circular-import deadlock (ленивый импорт telethon.tl.functions.stories в thread-pool). Поодиночке ок. Кандидат на фикс — преимпорт telethon на module-load (отметить в Phase 5/6).
- [x] **P2-08** · cloner · Починен контракт: эндпоинт теперь принимает UI `config{}` (раньше дропался целиком → copy*items всегда дефолт). `_normalize_cloner_config` выводит copy_items из copy_posts/profile/avatar/pinned, остальное (replacements/max_posts_per_day/active_hours/delays) → schedule_config. Воркер: copy profile (EditTitle) / avatar (EditPhoto) / pinned (поиск+репост+pin), replacements (`old→new` парсинг, применяются к тексту/заголовку), max_posts_per_day (cap на fetch), active-hours gate (PAUSED), delay из конфига. Live: create→copy_items=['posts','profile','avatar']+schedule_config, gate→PAUSED (cloner_outside_active_hours). Реальное клонирование не тестировал live (пишет в реальный канал) — логика + контракт проверены. *(commit P2-08)\_
- [x] **P2-09** · channel-creator · Воркер применяет username*pattern (UpdateUsernameRequest, {n}-подстановка) + permissions (EditChatDefaultBannedRightsRequest, default banned rights). description уже работал (about). Аватара нет в схеме/модели — пропущено (нет поля). Бонус: UI слал `account_ids`, а модель ждала `creator_account_ids` → выбор аккаунтов молча терялся; добавлен alias. Live: create→username_pattern/permissions/creator_account_ids сохранены; dispatch с fake-acc → FAILED gracefully, 0 каналов, без краша. Реальное создание не тестировал (создаёт реальные TG-каналы). master_account/pinned_message/welcome_post UI шлёт, но их нет в схеме — нота для будущего (нужны колонки). *(commit P2-09)\_
- [x] **P2-10** · settings · Механизм гейтинга: `notify_admin_pref(db, event_key, text)` в core/notify.py + `_EVENT_TO_PREF` (emergency*stop/spam_block → колонки, hot_lead/approval_queue/warmup_ready/daily_digest/ai_budget/long_task → extra_settings; default-on при неизвестном ключе/ошибке). Подключены low-risk call-sites: arena pause (long_task), beat membership auto-pause (spam_block), join_chats completion (long_task). Live: unit-тест \_pref_enabled (default True; disable extra/колонку → False; unknown → True; suppressed → лог+False), worker рестарт без ошибок. *(commit P2-10)\_
  - 🔸 **P2-10b (отложено, под-задача)**: 3 вызова notify_admin в `ai_agent_tasks.py` (1880/2114/2158 — hot_lead/approval_queue, живой движок) НЕ трогал, чтобы не рисковать регрессией live ai_agent. Адаптировать на notify_admin_pref отдельным заходом с осторожным live-прогоном.
- [x] **P2-11** · Сквозное · Итог аудита «UI-поле → воркер» (см. таблицу ниже). _(commit P2-11)_

### Итог Фазы 2 — «UI-поле → читается воркером»

| Раздел          | Подключено к воркеру                                                                                                     | Задизейблено в UI (нет данных) | Отложено (нужна инфра)                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| dm-campaign     | active_hours, filter_username, filter_ai_score_min, exclude_audience_id, skip_list, max_per_day, distribution(RANDOM/RR) | filter_online                  | GEO_MATCHED (гео прокси P6-08), message-level interleave                       |
| chat-broadcast  | exclude_channels, gap_24h, posts_per_day, ban_auto_stop, slow_mode_behavior, distribution(RR)                            | —                              | delete_detection→P4-22, drip/schedule→P5-04                                    |
| inviting        | filter_premium, filter_ai_score_min, privacy_threshold                                                                   | filter_online                  | flood_behavior (покрыт глоб. настройками)                                      |
| boost           | active_hours gate                                                                                                        | —                              | per-account дневные счётчики→P5-01, drip→P5-04                                 |
| stories-boost   | active_hours gate                                                                                                        | —                              | AUTO_MONITOR→P4-06/P5-04                                                       |
| cloner          | copy_items(posts/profile/avatar/pinned), replacements, max_posts_per_day, active_hours, delays                           | —                              | реальное клонирование не live-тестилось; mirror/schedule→P4-09                 |
| channel-creator | username_pattern, permissions, description, account_ids(alias)                                                           | —                              | avatar (нет колонки), master_account/pinned_message/welcome_post (нет колонок) |
| settings        | notify_admin_pref-гейтинг (arena/beat/join)                                                                              | —                              | ai_agent hot-path notify→P2-10b                                                |

**Регресс Ф2:** полный прогон + чистка.
