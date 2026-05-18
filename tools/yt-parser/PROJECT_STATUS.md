# YouTube Parser - Project Status

## Завершённые этапы

- Этап 0: git init, бэкап БД, чистка
- Этап 1: enrichment - 25/25 лидов с last_videos_json,
  24/25 с осмысленными recent_topics
- Уровень 1: ✅ мульти-проектная архитектура
  - sample_pitches per project (поле в БД)
  - project-aware generateContentSummary
  - content_red_flags per project
  - parseProjectId helper
  - привязка лидов к project_id (25 лидов → id=3)
  - тестовый проект id=4 "CopyBanner Test"
- Уровень 2: ✅ качество генерации питчей
  - sample_pitches для id=4 (4 примера: 2 хороших + 2 плохих)
  - country-personas RU переписана (~70 слов, запреты явные)
  - static rules ai.js: правила 11, 12, 13 + жёсткий лимит длины (правило 14)
  - critique-pass: anchored rubric (10/8/6/4), обязательные провалы по длине,
    threshold < 7
  - контрольная генерация: 3/3 питчей в норме
    (длина 69–89 слов, без ссылок в теле, без пересказа метрик,
    отсылки к recent_topics у всех 3)

## Текущее состояние генерации

- Питчи на CopyBanner-оффере (project id=4) — готовы для отправки
- Score критика: 8–9, retry не требуется
- Качественный скачок vs первая генерация:
  с 165 слов и метрик → 73 слова и конкретные темы

## Текущее состояние БД

- projects: id=3 CopyBanner (active), id=4 Test (inactive)
- leads: 25 штук, все привязаны к project_id=3
- recent_topics: 24/25 заполнены реальными темами без галлюцинаций
- pitch_hooks: project-aware, упоминают CopyBanner

## Уровень 3 — доставка (следующий)

- [ ] Resend setup + домен + DNS (SPF/DKIM/DMARC) — не настроено (.env пустой)
- [ ] IMAP для входящих — не настроено
- [ ] GDPR unsubscribe механизм + миграция БД (opted_out column) — не реализовано
- [ ] Dry-run на 5 лидах — заблокировано Resend
- [ ] Прогрев домена (5 → 10 → 25 в день) — заблокировано Resend

## Технический долг (минор, не блокеры)

- Critique threshold 7 (поднимать до 8 не стоит — +30–40% API без качества)
- Few-shot примеры парсятся JSON.parse на каждый вызов (некритично)
- Системный промпт generateContentSummary содержит "Все поля заполняй коротко" —
  может конфликтовать с required полями, но сейчас работает

## Что НЕ настроено (.env пустые)

- RESEND_API_KEY, EMAIL_FROM, EMAIL_DOMAIN
- IMAP_HOST, IMAP_USER, IMAP_PASS
- TG_API_ID, TG_API_HASH, TG_PHONE
- ADMIN_BOT_TOKEN, ADMIN_TG_CHAT_ID

## Архитектурные правила

- Проекты создаются через POST /api/projects (есть полноценный CRUD)
- Активный проект — один в системе (защищено логикой POST /api/projects/:id/activate)
- Лиды привязываются через project_id, без привязки используют активный
- generateContentSummary всегда вызывается с project (или fallback на активный)
