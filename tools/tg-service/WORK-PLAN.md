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
| 4         | Средние улучшения (M, low-med)                  | 28     | ☐        |
| 5         | Сквозная инфраструктура (общие компоненты)      | 9      | ☐        |
| 6         | Крупные/стратегические (L, med+)                | 11     | ☐        |
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
- **ФАЗА 1 завершена (12/12)** — commits P1-01..P1-12. Регресс 26/26 чисто, тестовые записи удалены (вкл. 3 старые test-аудитории), аккаунты 9 ACTIVE + 1 INVALID (без изменений), зависших WARMING нет. Следующий заход начинает с ФАЗЫ 2 (P2-01).
- **ФАЗА 2 частично (7/11)** — commits P2-01..P2-07. Закрыты фантомные config-поля DM (фильтры/active_hours/distribution), chat-broadcast (exclude/gap_24h/posts_per_day/ban_auto_stop/slow_mode/distribution), inviting (filter_premium/ai_score/privacy_threshold), boost+stories (active-hours gate). Checkpoint-регресс 26/26 чисто; Atlas-персона возвращена в ACTIVE (временно ставилась PAUSED для чистоты live-тестов); тестовых записей нет; аккаунты 9 ACTIVE + 1 INVALID; WARMING 0.
  - **ФАЗА 2 завершена (11/11)** — commits P2-01..P2-11. Регресс 26/26 чисто; тестовых записей нет (вкл. подчищенные m4-h3-recheck/m4-rotation/t3-503); аккаунты 9 ACTIVE + 1 INVALID; WARMING 0; settings/extra_settings восстановлены; Atlas → ACTIVE. Отложено: **P2-10b** (ai_agent hot-path notify). Следующий заход — **ФАЗА 3 (P3-01)**.
  - **ФАЗА 3 частично (3/21)** — commits P3-01..P3-03 (accounts health-фильтр; custom-avatar upload + seeded fallback; profile preview). Чекпоинт-регресс 26/26 чисто; Atlas ACTIVE; аккаунты 9 ACTIVE + 1 INVALID; тестовых записей нет. **Резюме-точка: P3-04** (pre-check username через CheckUsername — нужен телеграм-клиент, live-тест ограничен). Дальше P3-05 proxy import-форматы (бэкенд, изолированно), P3-06 beat авто-EXPIRED, P3-07..09 dashboard (один файл), и т.д.
  - ⚠️ Для live-тестов воркера: Atlas-персона (ACTIVE) сильно загружает воркер (циклы по 192с, прокси в dev недоступен). На время тестов её можно временно ставить PAUSED и обязательно возвращать в ACTIVE. Рестарт воркера — только `./scripts/dev-down.sh` + kill celery, иначе старый код висит (порт 8001 = только API).
