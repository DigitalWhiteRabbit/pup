# Changelog

Все важные изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

### Исправлено

- `/api/health` сделан динамическим (`force-dynamic`) — отдаёт живой timestamp и реальную проверку БД на каждый запрос (раньше кэшировался на этапе сборки)
- deploy.sh: yt-parser снова поднимается на каждом деплое (`pm2 delete` + `pm2 start ecosystem.config.js`); раньше падал и не вставал
- yt-parser зафиксирован на порту 3001 в `ecosystem.config.js` (раньше в контексте деплоя уезжал на 3000 и конфликтовал с pup)
- Telegram прогресс-бар деплоя обновляется в реальном времени по реальным стадиям — его теперь ведёт deploy.sh, а не таймер внутри pup (который умирал при `pm2 stop pup`)

## [0.2.0] - 2026-05-21

### Безопасность

- Исправлен дефолтный AUTH_SECRET и пустой CHAT_JWT_SECRET
- Закрыт RCE через deploy webhook без проверки подписи
- Исправлена SSRF уязвимость в external users proxy
- Исправлены XSS через dangerouslySetInnerHTML (dashboard, KB)
- Добавлена проверка membership в 36 marketing API routes (IDOR)
- Исправлен mass assignment в marketing config и leads
- Добавлена аутентификация на ICE servers endpoint
- Добавлены security headers (CSP, HSTS, X-Frame-Options)
- CORS wildcard заменён на dynamic origin
- Исправлена утечка данных между тенантами в inbox processing

### Добавлено

- /api/health endpoint для мониторинга
- GitHub Actions CI/CD (typecheck, lint, test, build)
- GitHub Actions security audit (weekly)
- Graceful shutdown (SIGTERM/SIGINT)
- Валидация env-переменных при старте (Zod)
- Circuit breaker для marketing worker
- Lead status state machine
- Skip-link навигация
- prefers-reduced-motion поддержка

### Исправлено

- SLA пересчитывается от текущего момента, не от createdAt
- Ticket number race condition (транзакция с retry)
- Dashboard N+1: 65 запросов → 5
- Polling снижен на 80% (chat, CRM, voice, notifications)
- AudioContext утечка в уведомлениях и WebRTC
- Dark mode: ~170 исправлений в 11 файлах
- Auto-scroll не ломает чтение истории в чате
- Двойная отправка сообщений при Enter
- Online индикатор показывает реальный статус
- Notification click ведёт в CRM, не на dashboard
- 22+ aria-label для доступности

### Удалено

- 23 мусорных "copy 2/3" директории
- googleapis из основных зависимостей
- Debug console.log из auth.ts
