# Деплой ПУП

Инструкции по развёртыванию на production-сервере.

## Серверная инфраструктура

| Компонент      | Описание                                                 |
| -------------- | -------------------------------------------------------- |
| Сервер         | VPS (77.37.120.232, ssh-алиас `pup`)                     |
| ПУП            | `/var/www/pup`, порт 3000, PM2-процесс `pup`             |
| YouTube-парсер | `/var/www/yt-parser`, порт 3001, PM2-процесс `yt-parser` |
| БД             | PostgreSQL (production)                                  |
| Веб-сервер     | nginx (`/etc/nginx/sites-available/pupanel.cc`)          |
| Домен          | pupanel.cc                                               |

## Процесс деплоя

Деплой запускается автоматически по GitHub webhook при пуше в `main`:

```
Push → GitHub webhook → deploy.sh → остановка PM2 → git pull → pnpm install → build → запуск PM2
```

### Что делает deploy.sh

1. Останавливает оба PM2-процесса (`pup` + `yt-parser`) -- обязательно перед сборкой, иначе OOM
2. `git pull origin main`
3. `pnpm install --frozen-lockfile`
4. `npx prisma migrate deploy` (применение миграций)
5. `NODE_OPTIONS="--max-old-space-size=3072" pnpm build`
6. Синхронизация файлов парсера в `/var/www/yt-parser`
7. Запуск обоих PM2-процессов
8. Отправка уведомления в Telegram (deploy.ts с прогресс-баром)

### Страница обслуживания

Nginx настроен на отдачу `/var/www/maintenance.html` при 502-ошибке (когда PM2-процессы остановлены). Страница автоматически обновляется каждые 10 секунд.

```nginx
error_page 502 /maintenance.html;
location = /maintenance.html {
    root /var/www;
    internal;
}
```

## Переменные окружения на сервере

Файл `/var/www/pup/.env` должен содержать:

### Обязательные

```bash
# База данных
DATABASE_URL="postgresql://user:pass@localhost:5432/pup?connection_limit=10&pool_timeout=30"

# Аутентификация
AUTH_SECRET="<openssl rand -base64 32>"
NEXTAUTH_SECRET="<то же значение, что AUTH_SECRET>"
NEXTAUTH_URL="https://pupanel.cc"

# JWT для публичного чат-виджета
CHAT_JWT_SECRET="<openssl rand -base64 32>"
```

### AI и голос

```bash
# Claude AI (агент тикетов, маркетинг-питчи, голосовые резюме)
ANTHROPIC_API_KEY="sk-ant-..."

# Groq Whisper (транскрипция голосовых сообщений)
GROQ_API_KEY="gsk_..."

# TURN-сервер (WebRTC через NAT)
TURN_PROVIDER="metered"
METERED_DOMAIN="pupanel.metered.live"
METERED_API_KEY="..."
```

### Маркетинг / Email

```bash
# Resend (отправка email)
RESEND_API_KEY="re_..."
EMAIL_FROM="partnerships@defi-outreach.cc"
RESEND_SENDER_NAME="..."

# IMAP (получение ответов)
IMAP_HOST="..."
IMAP_PORT="993"
IMAP_USER="..."
IMAP_PASS="..."
```

### Telegram

```bash
# Бот уведомлений
TELEGRAM_BOT_TOKEN="..."
TELEGRAM_BOT_USERNAME="..."

# Админ-бот (деплой, ошибки)
ADMIN_BOT_TOKEN="..."
ADMIN_TG_CHAT_ID="..."
```

### Деплой

```bash
GITHUB_WEBHOOK_SECRET="..."
DEPLOY_CHAT_ID="..."
```

### Сидинг

```bash
INITIAL_ADMIN_LOGIN="admin"
INITIAL_ADMIN_EMAIL="admin@example.com"
INITIAL_ADMIN_PASSWORD="..."
```

Полный список переменных с описанием: [.env.example](.env.example).

## PM2-команды

```bash
# Статус процессов
pm2 status

# Запуск
pm2 start pup
pm2 start yt-parser

# Остановка
pm2 stop pup
pm2 stop yt-parser

# Перезапуск
pm2 restart pup
pm2 restart yt-parser

# Логи (все)
pm2 logs

# Логи конкретного процесса
pm2 logs pup --lines 100
pm2 logs yt-parser --lines 100

# Мониторинг в реальном времени
pm2 monit
```

## Nginx

Конфигурация: `/etc/nginx/sites-available/pupanel.cc`

Ключевые настройки:

- Проксирование `/` на `localhost:3000` (ПУП)
- Проксирование `/yt-parser/` на `localhost:3001` (YouTube-парсер)
- SSE-соединения: `proxy_buffering off` (для потоковых событий)
- 502-ошибка: отдача `maintenance.html`

```bash
# Проверка конфигурации
sudo nginx -t

# Перезагрузка
sudo systemctl reload nginx
```

## Мониторинг

### Проверка работоспособности

```bash
# ПУП
curl -s https://pupanel.cc/api/health | jq

# YouTube-парсер
curl -s https://pupanel.cc/yt-parser/health | jq

# PM2-статус
pm2 status
```

### Логи

```bash
# Последние ошибки ПУП
pm2 logs pup --err --lines 50

# Все логи парсера
pm2 logs yt-parser --lines 50

# Логи nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

## Откат

При проблемах после деплоя:

```bash
# 1. Остановить процессы
pm2 stop pup yt-parser

# 2. Откатить на предыдущий коммит
cd /var/www/pup
git log --oneline -5          # найти нужный коммит
git revert HEAD --no-edit     # откат последнего коммита (безопасный способ)

# 3. Пересобрать
pnpm install --frozen-lockfile
npx prisma migrate deploy
NODE_OPTIONS="--max-old-space-size=3072" pnpm build

# 4. Запустить
pm2 start pup yt-parser
```

Если нужен откат нескольких коммитов:

```bash
git revert HEAD~3..HEAD --no-edit   # откат последних 3 коммитов
```

Если миграция вызвала проблему -- восстановите БД из бэкапа (см. ниже).

## Резервное копирование БД

Рекомендуется настроить ежедневный pg_dump через cron:

```bash
# Создать директорию для бэкапов
sudo mkdir -p /var/backups/pup
sudo chown postgres:postgres /var/backups/pup

# Добавить в crontab (sudo crontab -u postgres -e)
0 3 * * * pg_dump pup | gzip > /var/backups/pup/pup_$(date +\%Y\%m\%d_\%H\%M).sql.gz

# Удаление бэкапов старше 30 дней
0 4 * * * find /var/backups/pup -name "*.sql.gz" -mtime +30 -delete
```

### Восстановление из бэкапа

```bash
# Остановить приложение
pm2 stop pup

# Восстановить
gunzip < /var/backups/pup/pup_20260520_0300.sql.gz | psql pup

# Запустить
pm2 start pup
```

## Сборка: важные ограничения

- На сервере ограничена память. Используйте `NODE_OPTIONS="--max-old-space-size=3072"` при сборке.
- Перед сборкой обязательно остановите PM2-процессы -- иначе сборка упадёт с OOM.
- deploy.sh делает это автоматически, но при ручной сборке не забудьте.
