# Quickstart: CRM Канбан-система

**Требования**: Node.js 20+, pnpm 9+

---

## 1. Установка зависимостей

```bash
pnpm install
```

---

## 2. Настройка окружения

```bash
cp .env.example .env
```

Заполнить `.env`:

```env
DATABASE_URL="file:./prisma/dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="<сгенерировать: openssl rand -base64 32>"
TELEGRAM_BOT_TOKEN=""          # опционально для локалки
STORAGE_DRIVER="local"
UPLOAD_DIR="./uploads"
INITIAL_ADMIN_LOGIN="admin"
INITIAL_ADMIN_EMAIL="[email protected]"
INITIAL_ADMIN_PASSWORD="<временный пароль>"
```

---

## 3. База данных

### Первый запуск (создание схемы)

```bash
pnpm db:migrate
# эквивалент: prisma migrate dev --name init
```

### Создание первого администратора

```bash
pnpm db:seed
# Читает INITIAL_ADMIN_* из .env, создаёт ADMIN-аккаунт
```

### ⚠️ Перед каждой миграцией (Constitution V)

```bash
# Локально — сделать копию dev.db
cp prisma/dev.db prisma/dev.db.bak

# В проде — pg_dump перед migrate deploy
pg_dump -Fc $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).dump
```

---

## 4. Запуск dev-сервера

```bash
pnpm dev
# Открыть: http://localhost:3000
```

---

## 5. Первый вход

1. Открыть `http://localhost:3000/login`
2. Войти с `INITIAL_ADMIN_LOGIN` / `INITIAL_ADMIN_PASSWORD`
3. Открыть `/admin/users` → создать первых пользователей
4. Система покажет временный пароль — скопировать и передать пользователю

---

## 6. Telegram (опционально для локалки)

1. Создать бота через [@BotFather](https://t.me/BotFather) → получить токен
2. Вставить токен в `.env` как `TELEGRAM_BOT_TOKEN`
3. Перезапустить `pnpm dev`
4. В настройках профиля пользователя → «Подключить Telegram» → скопировать код
5. Отправить боту: `/start <код>`

---

## 7. Полезные команды

```bash
pnpm dev            # запуск dev-сервера (Next.js + Telegram bot polling)
pnpm build          # production сборка
pnpm start          # запуск production сборки
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm db:migrate     # создать/применить миграции (dev)
pnpm db:reset       # сбросить БД и пересоздать (dev only!)
pnpm db:seed        # создать первого ADMIN из .env
pnpm test           # Vitest unit-тесты
pnpm test:watch     # Vitest в watch-режиме
```

---

## 8. Структура проекта

```text
/
├── app/
│   ├── (auth)/
│   │   └── login/
│   ├── (authenticated)/
│   │   ├── projects/
│   │   ├── projects/[id]/        # доска
│   │   ├── admin/users/
│   │   └── settings/profile/
│   └── api/
│       ├── auth/[...nextauth]/
│       ├── projects/
│       ├── columns/
│       ├── tasks/
│       ├── comments/
│       ├── attachments/
│       ├── notifications/
│       ├── profile/
│       └── admin/
├── components/
│   ├── ui/                       # shadcn/ui примитивы
│   ├── board/                    # Column, TaskCard, TaskModal
│   └── forms/
├── lib/
│   ├── db.ts                     # Prisma client singleton
│   ├── auth.ts                   # NextAuth config
│   ├── schemas/                  # Zod-схемы (по одной на сущность)
│   └── services/
│       ├── auth.service.ts
│       ├── project.service.ts
│       ├── task.service.ts
│       ├── timer.service.ts
│       ├── notification.service.ts
│       ├── storage/
│       │   ├── types.ts          # FileStorage interface
│       │   ├── local.storage.ts
│       │   └── index.ts          # factory (STORAGE_DRIVER)
│       └── telegram/
│           ├── bot.ts            # инициализация long-polling
│           └── sender.ts         # отправка с retry
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── scripts/                      # CLI утилиты
├── tests/
│   └── unit/
├── uploads/                      # gitignored
├── .env.example
└── package.json
```

---

## 9. Smoke-тест (ручная проверка после запуска)

- [ ] Вход под ADMIN → доступен `/admin/users`
- [ ] Создание USER → получен временный пароль
- [ ] Вход под USER → редирект на `/projects`
- [ ] Создание проекта → появились 3 колонки по умолчанию
- [ ] Создание задачи → задача появилась в колонке
- [ ] Drag&drop задачи в "В работе" → на карточке виден счётчик
- [ ] Перемещение задачи из "В работе" → счётчик остановился, время сохранилось
- [ ] Прикрепление файла → файл скачивается
- [ ] Попытка открыть файл без сессии → 403
