# API Contracts: CRM Канбан-система

**Branch**: `001-crm-kanban-system` | **Date**: 2026-05-05

Все эндпоинты валидируются через Zod (Constitution III).
Все ответы с ошибкой имеют форму `{ error: string, code: string }`.
Все защищённые маршруты требуют активной сессии (401 при отсутствии).

---

## Общие типы

```typescript
// Пагинация (обязательна для списков 50+ элементов)
type PaginatedResponse<T> = {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// Стандартная ошибка
type ErrorResponse = {
  error: string   // human-readable
  code: string    // machine-readable: "NOT_FOUND", "FORBIDDEN", etc.
}
```

---

## Auth

### `POST /api/auth/[...nextauth]`
Обрабатывается NextAuth v5. Поддерживает:
- `POST /api/auth/signin` — логин через Credentials (login/email + password)
- `POST /api/auth/signout` — выход
- `GET /api/auth/session` — текущая сессия

---

## Projects

### `GET /api/projects`
Список проектов текущего пользователя (OWNER или MEMBER). ADMIN видит все.

**Response** `200`:
```typescript
PaginatedResponse<{
  id: string
  name: string
  description: string | null
  owner: { id: string; login: string }
  memberCount: number
  createdAt: string
}>
```

**Query params**: `page` (default: 1), `pageSize` (default: 20)

---

### `POST /api/projects`
Создать проект. Создатель автоматически становится OWNER.

**Body**:
```typescript
{ name: string; description?: string }
```

**Validation**: `name` — не пустая строка, макс. 100 символов.

**Response** `201`:
```typescript
{
  id: string
  name: string
  description: string | null
  columns: Array<{ id: string; name: string; position: number }>
}
```

**Side effect**: создаются 3 дефолтные колонки ("Ожидает", "В работе", "Готово").

---

### `GET /api/projects/:id`
Полная загрузка доски: проект + колонки + задачи + assignee.

**Access**: OWNER, MEMBER, ADMIN.

**Response** `200`:
```typescript
{
  id: string
  name: string
  description: string | null
  owner: { id: string; login: string }
  members: Array<{ id: string; login: string; role: "OWNER" | "MEMBER" }>
  columns: Array<{
    id: string
    name: string
    position: number
    tasks: Array<{
      id: string
      title: string
      description: string | null
      position: number
      assignee: { id: string; login: string; isActive: boolean } | null
      totalTimeMs: number      // суммарное время из TimeInterval
      isInProgress: boolean    // есть ли открытый TimeInterval
      createdAt: string
    }>
  }>
}
```

**Performance**: один Prisma-запрос с `include` (нет N+1).

---

### `PATCH /api/projects/:id`
Обновить название/описание. Только OWNER или ADMIN.

**Body**: `{ name?: string; description?: string }`

**Response** `200`: обновлённый проект (id, name, description).

---

### `DELETE /api/projects/:id`
Удалить проект. Только OWNER или ADMIN.

**Response** `204`.

**Side effect**: каскадное удаление в БД + физическое удаление `uploads/{projectId}/`.

---

### `POST /api/projects/:id/members`
Добавить участника. Только OWNER.

**Body**: `{ loginOrEmail: string }`

**Response** `201`:
```typescript
{ userId: string; login: string; email: string; role: "MEMBER" }
```

**Errors**: `404 USER_NOT_FOUND`, `409 ALREADY_MEMBER`.

**Side effect**: `Notification` типа `PROJECT_ADDED` для нового участника.

---

### `DELETE /api/projects/:id/members/:userId`
Удалить участника. Только OWNER (нельзя удалить самого себя как OWNER).

**Response** `204`.

---

## Columns

### `GET /api/projects/:id/columns`
Список колонок проекта (с количеством задач). Включено в `GET /api/projects/:id`, используется
отдельно для легковесных обновлений.

**Response** `200`: `Array<{ id, name, position, taskCount }>`

---

### `POST /api/projects/:id/columns`
Создать колонку. Любой участник.

**Body**: `{ name: string }` (макс. 50 символов)

**Response** `201`: `{ id, name, position }`

**Logic**: `position = MAX(existing) + 1`.

---

### `PATCH /api/columns/:id`
Переименовать колонку. Любой участник.

**Body**: `{ name: string }`

**Response** `200`: `{ id, name }`

**Side effects (атомарная транзакция)**:
- Если новое имя = "в работе" (case-insensitive) и старое ≠: `INSERT TimeInterval` для всех задач колонки.
- Если старое имя = "в работе" и новое ≠: `UPDATE TimeInterval SET endedAt` для всех открытых.

---

### `PATCH /api/columns/:id/position`
Изменить порядок колонки (после drag&drop).

**Body**: `{ position: number }`

**Response** `200`: все колонки проекта с обновлёнными позициями.

---

### `DELETE /api/columns/:id`
Удалить колонку. Только OWNER.

**Errors**: `409 COLUMN_HAS_TASKS` — если в колонке есть задачи.

**Response** `204`.

---

## Tasks

### `GET /api/projects/:id/tasks`
Плоский список задач проекта (для поиска в будущем). В MVP используется редко — доска грузит задачи
через `GET /api/projects/:id`.

**Query params**: `columnId?`, `assigneeId?`, `page`, `pageSize` (default: 50).

**Response** `200`: `PaginatedResponse<TaskSummary>`

---

### `POST /api/projects/:id/tasks`
Создать задачу. Любой участник.

**Body**:
```typescript
{
  title: string        // макс. 200 символов
  description?: string
  columnId: string
  assigneeId?: string
}
```

**Response** `201`:
```typescript
{
  id: string
  title: string
  description: string | null
  columnId: string
  position: number
  assignee: { id: string; login: string } | null
  createdAt: string
  totalTimeMs: 0
  isInProgress: false
}
```

**Side effect**: если колонка "В работе" — открывается `TimeInterval`.
Если назначен assignee ≠ автор — `Notification` типа `ASSIGNED`.

---

### `GET /api/tasks/:id`
Полная карточка задачи (для модального окна).

**Response** `200`:
```typescript
{
  id: string
  title: string
  description: string | null
  columnId: string
  columnName: string
  position: number
  assignee: { id: string; login: string; isActive: boolean } | null
  totalTimeMs: number
  isInProgress: boolean
  createdAt: string
  comments: Array<{
    id: string
    text: string
    author: { id: string; login: string }
    createdAt: string
    updatedAt: string
  }>
  attachments: Array<{
    id: string
    originalName: string
    size: number
    mimeType: string
    uploadedBy: { id: string; login: string }
    uploadedAt: string
  }>
  moveHistory: Array<{
    fromColumnName: string
    toColumnName: string
    movedBy: { id: string; login: string }
    movedAt: string
  }>
}
```

---

### `PATCH /api/tasks/:id`
Обновить поля задачи (title, description, assignee). Не для перемещения между колонками.

**Body**: `{ title?: string; description?: string; assigneeId?: string | null }`

**Response** `200`: обновлённая задача (summary).

**Side effect**: если assigneeId изменился на нового пользователя ≠ инициатор — `Notification ASSIGNED`.

---

### `DELETE /api/tasks/:id`
Удалить задачу. Любой участник.

**Response** `204`.

**Side effects**: закрытие открытых `TimeInterval`, удаление физических файлов вложений.

---

### `POST /api/tasks/:id/move`
Атомарное перемещение задачи. Отдельный эндпоинт — потому что это транзакция из 4+ операций.

**Body**:
```typescript
{
  columnId: string     // целевая колонка
  position: number     // позиция в целевой колонке
}
```

**Response** `200`:
```typescript
{
  taskId: string
  columnId: string
  position: number
  totalTimeMs: number
  isInProgress: boolean
}
```

**Транзакция (атомарно)**:
1. `UPDATE Task SET columnId, position`
2. Пересчёт position соседних задач
3. `INSERT ColumnMoveLog`
4. Если уходим из "В работе" → `UPDATE TimeInterval SET endedAt = now`
5. Если приходим в "В работе" → `INSERT TimeInterval { startedAt: now }`
6. `INSERT Notification MOVED` для assignee (если assignee ≠ инициатор)
7. **После** транзакции (async): отправка Telegram-уведомления

---

### `PATCH /api/tasks/:id/position`
Изменить порядок задачи внутри колонки (drag&drop внутри колонки).

**Body**: `{ position: number }`

**Response** `200`: `{ taskId, position }`

---

## Comments

### `GET /api/tasks/:id/comments`
Список комментариев задачи (включён в `GET /api/tasks/:id`).

---

### `POST /api/tasks/:id/comments`
Добавить комментарий. Любой участник проекта.

**Body**: `{ text: string }` (1–10000 символов)

**Response** `201`: `{ id, text, author, createdAt, updatedAt }`

**Side effect**: `Notification COMMENTED` для assignee задачи и автора задачи (если не сам комментатор).

---

### `PATCH /api/comments/:id`
Редактировать комментарий. Только автор.

**Body**: `{ text: string }`

**Response** `200`: `{ id, text, updatedAt }`

---

### `DELETE /api/comments/:id`
Удалить комментарий. Только автор.

**Response** `204`.

---

## Attachments

### `POST /api/tasks/:id/attachments`
Загрузить файл. `multipart/form-data`. Любой участник.

**Body**: `FormData` с полем `file`.

**Response** `201`:
```typescript
{
  id: string
  originalName: string
  size: number
  mimeType: string
  uploadedBy: { id: string; login: string }
  uploadedAt: string
}
```

**Logic**: `storagePath = uploads/{projectId}/{taskId}/{uuid}-{originalName}`.

---

### `GET /api/attachments/:id`
Скачать файл. Проверка членства в проекте при каждом запросе.

**Response**: бинарный поток с `Content-Disposition: attachment`.

**Errors**: `403 FORBIDDEN` если не участник проекта.

---

### `DELETE /api/attachments/:id`
Удалить вложение. Загрузивший или OWNER проекта.

**Response** `204`.

**Side effect**: удаление физического файла через `FileStorage.delete()`.

---

## Notifications

### `GET /api/notifications`
Список уведомлений текущего пользователя.

**Query params**: `unreadOnly?` (boolean), `page`, `pageSize` (default: 50).

**Response** `200`: `PaginatedResponse<Notification>`

```typescript
type Notification = {
  id: string
  type: "ASSIGNED" | "COMMENTED" | "MOVED" | "PROJECT_ADDED"
  isRead: boolean
  createdAt: string
  task?: { id: string; title: string; projectId: string } | null
  project?: { id: string; name: string } | null
}
```

---

### `POST /api/notifications/read`
Отметить уведомления прочитанными (одно или все).

**Body**: `{ ids?: string[] }` — если не передан, отмечаются все.

**Response** `200`: `{ updatedCount: number }`

---

## Profile / Telegram

### `POST /api/profile/telegram/generate-code`
Сгенерировать одноразовый код привязки (TTL 10 минут).

**Response** `200`: `{ code: string; expiresAt: string }`

**Logic**: `crypto.randomUUID()` → сохранить в `TelegramLinkToken`.

---

### `POST /api/profile/telegram/disconnect`
Отвязать Telegram.

**Response** `200`: `{ ok: true }`

**Logic**: `UPDATE User SET telegramChatId = null`.

---

## Admin

### `GET /api/admin/users`
Список всех пользователей. Только ADMIN.

**Query params**: `page`, `pageSize` (default: 50), `search?` (по логину/email).

**Response** `200`: `PaginatedResponse<UserAdmin>`

```typescript
type UserAdmin = {
  id: string
  login: string
  email: string
  role: "ADMIN" | "USER"
  isActive: boolean
  telegramConnected: boolean
  createdAt: string
}
```

---

### `POST /api/admin/users`
Создать пользователя. Только ADMIN.

**Body**: `{ login: string; email: string; role: "ADMIN" | "USER" }`

**Response** `201`:
```typescript
{
  id: string
  login: string
  email: string
  role: "ADMIN" | "USER"
  temporaryPassword: string  // показывается ОДИН раз, в БД хранится хэш
}
```

---

### `PATCH /api/admin/users/:id/deactivate`
Деактивировать пользователя. Только ADMIN.

**Response** `200`: `{ id, isActive: false }`

---

### `PATCH /api/admin/users/:id/activate`
Реактивировать пользователя. Только ADMIN.

**Response** `200`: `{ id, isActive: true }`

---

### `PATCH /api/admin/users/:id/role`
Изменить роль. Только ADMIN.

**Body**: `{ role: "ADMIN" | "USER" }`

**Response** `200`: `{ id, role }`

---

### `POST /api/admin/users/:id/reset-password`
Сбросить пароль. Только ADMIN.

**Response** `200`:
```typescript
{ temporaryPassword: string }  // показывается ОДИН раз
```
