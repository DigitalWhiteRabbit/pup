# YouTube Parser + AI Outreach Agent

Полноценная система для поиска YouTube-блогеров, извлечения их контактов и автономного outreach-а через AI-агента (Claude).

**Что умеет:**

- Парсит YouTube каналы по ключевым словам/хэштегам с фильтрами (подписчики, страна, engagement, активность)
- Извлекает контакты: email, Telegram, Instagram, Twitter, TikTok, VK, Discord, WhatsApp, сайты
- Управление лидами с двумя статусами: `lead_status` (админ) + `dialogue_stage` (агент)
- AI-агент пишет блогерам с учётом региона/тематики через **Email** и **Telegram** (gramjs)
- Ведёт диалог автономно, при упоминании цены — уведомляет админа в Telegram-боте с кнопками Approve/Reject
- Может консультироваться с админом через бот
- Аналитика, история парсингов, CRM статусы, мульти-кампании

---

## 1. Локальная установка

```bash
git clone <repo>
cd "Parsing for YT"
npm install
cp .env.example .env
# Заполни .env (минимум YOUTUBE_API_KEY и ANTHROPIC_API_KEY)
node server.js
```

Открыть http://localhost:3000

---

## 2. Получение ключей и сервисов

### YouTube Data API

1. https://console.cloud.google.com/ → создать проект
2. APIs & Services → Library → YouTube Data API v3 → Enable
3. Credentials → Create API Key
4. В `.env`: `YOUTUBE_API_KEY=...`
5. Бесплатная квота: 10 000 units/день

### Anthropic Claude API

1. https://console.anthropic.com/settings/keys → Create Key
2. В `.env`: `ANTHROPIC_API_KEY=sk-ant-...`
3. Стоимость: ~$0.05–0.20 за один диалог с блогером

### Resend (email)

1. https://resend.com → регистрация (бесплатно до 3000 писем/мес)
2. Domains → Add Domain → ввести свой домен
3. Добавить DNS записи (SPF, DKIM, DMARC) у регистратора домена
4. Дождаться подтверждения (~30 мин)
5. API Keys → Create → в `.env`: `RESEND_API_KEY=re_...`
6. В `.env`: `EMAIL_FROM=outreach@yourdomain.com`

### IMAP для приёма ответов

- Если у домена своя почта → используй её IMAP креды
- Альтернатива: Gmail с App Password (https://myaccount.google.com/apppasswords)
- В `.env`: `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`

### Telegram MTProto (gramjs)

1. https://my.telegram.org/apps → создать приложение → получить `api_id` и `api_hash`
2. **⚠️ Используй ОТДЕЛЬНЫЙ TG-аккаунт** (не основной — может прилететь ban за массовую рассылку)
3. В `.env`: `TG_API_ID`, `TG_API_HASH`, `TG_PHONE`
4. Запусти сервер → открой Настройки → нажми Login → введи SMS-код
5. Сессия сохраняется в SQLite, второй раз входить не нужно

### Admin Telegram Bot

1. В Telegram: @BotFather → /newbot → задать имя
2. Скопировать токен → в `.env`: `ADMIN_BOT_TOKEN=...`
3. Запустить сервер → написать своему боту /start → бот ответит твоим chat_id
4. В `.env`: `ADMIN_TG_CHAT_ID=...`
5. Перезапустить сервер
6. Бот будет присылать уведомления о сделках с inline-кнопками Approve/Reject

---

## 3. Архитектура

```
┌─ Express server (server.js)
│  ├─ /api/leads, /api/projects, /api/dialogues, /api/deals,
│  │  /api/consultations, /api/agent, /api/telegram
│  └─ Static UI (public/index.html)
│
├─ SQLite DB (data/parser.db)
│  └─ projects, leads, dialogues, messages, deals, consultations, settings
│
├─ services/
│  ├─ ai.js              — Claude API + persona builder
│  ├─ email.js           — Resend send + IMAP receive
│  ├─ telegram-outreach.js — gramjs MTProto (cold outreach)
│  ├─ admin-bot.js       — node-telegram-bot-api (admin notifications)
│  └─ outreach-worker.js — фоновый воркер (4 цикла: outreach, inbox, decisions, TG events)
│
└─ index.js (CLI парсер) — вызывается через child_process из server.js
```

**Workflow:**

1. Парсинг → CSV → авто-импорт в `leads` со `status=pending`
2. Админ во вкладке **Лиды** помечает Ready / Rejected
3. На вкладке **Диалоги** → ▶ Start Agent
4. Каждые 30 сек worker берёт следующий ready-лид → Claude генерит pitch → отправляет
5. Каждые 60 сек worker тянет inbox через IMAP / получает TG-сообщения через gramjs events
6. На входящие → Claude генерит ответ → отправляет
7. При упоминании цены → flag `price_mentioned` → создаётся deal → notification в admin bot
8. Админ нажимает Approve в боте → worker отправляет согласие блогеру

---

## 4. Деплой на VPS (Hetzner / Timeweb / любой Linux)

### Подготовка сервера

```bash
# Ubuntu 22.04
ssh root@your-vps-ip

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential git

# PM2 (process manager)
npm install -g pm2

# Nginx (опционально, для reverse proxy + HTTPS)
apt install -y nginx certbot python3-certbot-nginx
```

### Деплой кода

```bash
cd /opt
git clone <your-repo> yt-parser
cd yt-parser
npm install --production
cp .env.example .env
nano .env   # заполни все ключи
mkdir -p data logs
```

### Запуск через PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # выполни команду которую покажет
pm2 logs yt-parser
```

### Nginx + HTTPS (опционально)

```nginx
# /etc/nginx/sites-available/yt-parser
server {
    listen 80;
    server_name yt-parser.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;  # для SSE
    }
}
```

```bash
ln -s /etc/nginx/sites-available/yt-parser /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d yt-parser.yourdomain.com
```

### Безопасность

- Дашборд **не имеет авторизации** — обязательно используй HTTPS Basic Auth в Nginx или ограничь доступ по IP/VPN
- Закрой порт 3000 от внешнего доступа: `ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable`
- Регулярно бэкапь `data/parser.db` — там вся история диалогов

### Первый запуск на VPS

1. `pm2 logs` → проверь что сервер стартует без ошибок
2. Открой в браузере → перейди в **Настройки** → залогинь Telegram (SMS придёт на твой номер)
3. Создай **Кампанию** и активируй её
4. Запусти парсер из Dashboard
5. Триаж лидов на вкладке **Лиды**
6. **Диалоги** → ▶ Start agent
7. Получи первое уведомление о сделке в admin bot

---

## 5. CLI парсер (без UI)

```bash
node index.js --keywords "финансы,инвестиции" --min-subs 10000 --country RU --limit 100
```

Все флаги:

| Флаг                       | Описание                                              |
| -------------------------- | ----------------------------------------------------- |
| `--keywords`               | Ключевые слова через запятую                          |
| `--hashtags`               | Хэштеги через запятую                                 |
| `--min-subs`, `--max-subs` | Диапазон подписчиков                                  |
| `--min-engagement`         | Минимальный engagement rate (avg_views/subs)          |
| `--country`                | Код страны (RU, US, ...)                              |
| `--active-days`            | Канал публиковал видео за последние N дней            |
| `--limit`                  | Максимум каналов в CSV                                |
| `--append`                 | Добавить к существующему CSV без дублей               |
| `--no-cache`               | Не использовать кэш                                   |
| `--category`               | ID категории YouTube (28 = Tech, 27 = Education, ...) |
| `--sort-by`                | relevance / date / viewCount / rating                 |
| `--language`               | Язык поиска (ru, en, ...)                             |

---

## 6. Стоимость

| Сервис           | Free tier         | Платно с                   |
| ---------------- | ----------------- | -------------------------- |
| YouTube API      | 10 000 units/день | дальше нужен квота-апгрейд |
| Anthropic Claude | trial $5          | ~$0.05–0.20 за диалог      |
| Resend           | 3000 писем/мес    | $20/мес для 50k            |
| Hetzner CX11 VPS | —                 | €4.5/мес                   |

Минимум для запуска: ~$5/мес VPS + Claude credits.

---

## 7. Безопасность и риски

- **gramjs ban risk**: используй ОТДЕЛЬНЫЙ аккаунт, не более 30 сообщений/день
- **Email deliverability**: правильно настрой SPF/DKIM/DMARC чтобы не попадать в спам
- **GDPR**: для EU аудитории добавь unsubscribe link в письма (TODO)
- **Дашборд без auth** — закрой Basic Auth или VPN
- **Резервные копии**: `data/parser.db` содержит всю историю диалогов

---

## 8. Troubleshooting

| Проблема                     | Решение                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY не задан` | Проверь .env, перезапусти сервер                                    |
| Worker не отправляет письма  | Проверь что есть активная Кампания (Кампании → Активировать)        |
| Telegram login висит         | Перезапусти сервер, убедись что TG_PHONE правильный                 |
| Письма попадают в спам       | Проверь SPF/DKIM в Resend Dashboard, прогрей домен 1-2 недели       |
| `EADDRINUSE :3000`           | `lsof -ti :3000 \| xargs kill`                                      |
| gramjs auth error            | Удали `data/parser.db` settings.telegram_session, залогинься заново |
