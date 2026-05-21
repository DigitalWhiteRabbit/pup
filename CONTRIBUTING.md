# Как внести вклад в ПУП

## Быстрый старт

```bash
git clone git@github.com:DigitalWhiteRabbit/pup.git
cd pup
cp .env.example .env        # заполнить переменные
pnpm install
pnpm db:migrate
pnpm db:seed                 # или SEED_DEMO_DATA=true pnpm db:seed
pnpm dev
```

Подробнее — в [README.md](README.md).

## Git workflow

1. Создай ветку от `main`: `git checkout -b feat/my-feature`
2. Используй [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` — новая функциональность
   - `fix:` — исправление бага
   - `chore:` — рутина (зависимости, конфиг)
   - `refactor:` — рефакторинг без изменения поведения
   - `docs:` — документация
3. Один PR — одна задача. Держи PR компактными.

## Code style

- **Prettier** + **ESLint** — форматирование и линтинг запускаются автоматически через `lint-staged` при коммите.
- **TypeScript strict mode** — без `any`, без `@ts-ignore` без веской причины.
- Запуск вручную:
  ```bash
  pnpm lint        # ESLint
  pnpm typecheck   # tsc --noEmit
  ```

## Тесты

```bash
pnpm test          # vitest
```

Пиши тесты для новой логики. Не мержь PR с падающими тестами.

## Структура модулей

Каждый workspace содержит 8 модулей: `crm`, `knowledge`, `tickets`, `logs`, `chat`, `marketing`, `analytics`, `users`.

Файлы модуля:

```
app/(workspace)/workspaces/[workspaceId]/<module>/   # страницы
components/<module>/                                  # компоненты
lib/services/<module>.service.ts                      # бизнес-логика
app/api/workspaces/[workspaceId]/<module>/            # API routes
```

Подробнее — в [.specify/memory/architecture.md](.specify/memory/architecture.md).

## PR чеклист

Перед отправкой PR убедись:

- [ ] `pnpm typecheck` проходит без ошибок
- [ ] `pnpm lint` проходит без ошибок
- [ ] `pnpm test` — все тесты зелёные
- [ ] Нет `console.log` в коммите (кроме обоснованных случаев)
- [ ] Новые API routes проверяют membership (workspace isolation)
- [ ] Деструктивные действия имеют подтверждение
