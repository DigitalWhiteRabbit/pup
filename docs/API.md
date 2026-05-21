# API Reference -- ПУП

> Полная документация всех HTTP-эндпоинтов платформы ПУП.
> Актуально для текущей ветки `main` (2026-05-20).

## Оглавление

- [Соглашения](#соглашения)
- [Аутентификация](#аутентификация)
- [1. Workspace (ядро)](#1-workspace-ядро)
- [2. CRM (Kanban)](#2-crm-kanban)
- [3. Knowledge Base](#3-knowledge-base)
- [4. Tickets](#4-tickets)
- [5. Chat (внутренний)](#5-chat-внутренний)
- [6. Chat (публичный виджет)](#6-chat-публичный-виджет)
- [7. Marketing (AI Outreach)](#7-marketing-ai-outreach)
- [8. Voice (WebRTC)](#8-voice-webrtc)
- [9. Logs](#9-logs)
- [10. Global Chat](#10-global-chat)
- [11. Notifications](#11-notifications)
- [12. Admin](#12-admin)
- [13. Profile](#13-profile)
- [14. Users (система)](#14-users-система)
- [15. External Users](#15-external-users)
- [16. Служебные](#16-служебные)

---

## Соглашения

| Обозначение | Значение                                   |
| ----------- | ------------------------------------------ |
| `{id}`      | ID рабочего пространства (workspace)       |
| `session`   | Авторизация через next-auth session cookie |
| `ADMIN`     | Требуется роль ADMIN                       |
| `JWT`       | Bearer-токен клиента (публичный чат)       |
| `public`    | Без авторизации                            |
| `webhook`   | Подпись GitHub HMAC-SHA256                 |

Базовый путь: `/api`

Все эндпоинты возвращают JSON. При ошибке -- `{ error: string, code?: string }`.

---

## Аутентификация

| Метод | Путь                      | Описание                                             |
| ----- | ------------------------- | ---------------------------------------------------- |
| `*`   | `/api/auth/[...nextauth]` | NextAuth.js -- credentials provider (login/password) |

---

## 1. Workspace (ядро)

### Workspaces

| Метод    | Путь                   | Авторизация | Описание                                                             |
| -------- | ---------------------- | ----------- | -------------------------------------------------------------------- |
| `GET`    | `/api/workspaces`      | session     | Список workspace-ов текущего пользователя. Query: `page`, `pageSize` |
| `POST`   | `/api/workspaces`      | session     | Создать workspace. Body: `{ name, description? }`                    |
| `GET`    | `/api/workspaces/{id}` | session     | Получить workspace по ID                                             |
| `PATCH`  | `/api/workspaces/{id}` | session     | Обновить workspace. Body: `{ name?, description? }`                  |
| `DELETE` | `/api/workspaces/{id}` | session     | Удалить workspace (владелец)                                         |

### Модули

| Метод   | Путь                                       | Авторизация | Описание                        |
| ------- | ------------------------------------------ | ----------- | ------------------------------- |
| `GET`   | `/api/workspaces/{id}/modules`             | session     | Список всех модулей workspace-а |
| `PATCH` | `/api/workspaces/{id}/modules/{moduleKey}` | session     | Включить/выключить модуль       |

### Участники

| Метод    | Путь                                    | Авторизация | Описание                                     |
| -------- | --------------------------------------- | ----------- | -------------------------------------------- |
| `POST`   | `/api/workspaces/{id}/members`          | session     | Добавить участника. Body: `{ loginOrEmail }` |
| `DELETE` | `/api/workspaces/{id}/members/{userId}` | session     | Удалить участника                            |

### Лого

| Метод  | Путь                        | Авторизация | Описание                         |
| ------ | --------------------------- | ----------- | -------------------------------- |
| `POST` | `/api/workspaces/{id}/logo` | session     | Загрузить лого. FormData: `file` |

### Email-конфигурация

| Метод   | Путь                                | Авторизация | Описание                                                                                               |
| ------- | ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `GET`   | `/api/workspaces/{id}/email/config` | session     | Получить SMTP-настройки                                                                                |
| `PATCH` | `/api/workspaces/{id}/email/config` | session     | Обновить SMTP. Body: `{ enabled?, smtpHost?, smtpPort?, smtpUser?, smtpPass?, fromEmail?, fromName? }` |

### Dashboard

| Метод | Путь             | Авторизация | Описание                                                       |
| ----- | ---------------- | ----------- | -------------------------------------------------------------- |
| `GET` | `/api/dashboard` | session     | Агрегированный дашборд: workspace-ы, задачи, тикеты, чат, логи |

---

## 2. CRM (Kanban)

> См. также устаревший контракт: `specs/001-crm-kanban-system/contracts/api.md`
> (использует "projects" вместо "workspaces").

### Колонки

| Метод    | Путь                               | Авторизация | Описание                          |
| -------- | ---------------------------------- | ----------- | --------------------------------- |
| `GET`    | `/api/workspaces/{id}/columns`     | session     | Список колонок Kanban-доски       |
| `PATCH`  | `/api/columns/{columnId}`          | session     | Обновить колонку (название, цвет) |
| `DELETE` | `/api/columns/{columnId}`          | session     | Удалить колонку                   |
| `PATCH`  | `/api/columns/{columnId}/position` | session     | Изменить порядок колонки          |

### Задачи

| Метод    | Путь                           | Авторизация | Описание                      |
| -------- | ------------------------------ | ----------- | ----------------------------- |
| `GET`    | `/api/workspaces/{id}/tasks`   | session     | Список задач workspace-а      |
| `GET`    | `/api/tasks/{taskId}`          | session     | Задача по ID                  |
| `PATCH`  | `/api/tasks/{taskId}`          | session     | Обновить задачу               |
| `DELETE` | `/api/tasks/{taskId}`          | session     | Удалить задачу                |
| `PATCH`  | `/api/tasks/{taskId}/position` | session     | Drag-n-drop: изменить позицию |
| `PATCH`  | `/api/tasks/{taskId}/move`     | session     | Переместить между колонками   |

### Комментарии, чеклист, вложения

| Метод    | Путь                              | Авторизация | Описание                               |
| -------- | --------------------------------- | ----------- | -------------------------------------- |
| `POST`   | `/api/tasks/{taskId}/comments`    | session     | Добавить комментарий. Body: `{ text }` |
| `PATCH`  | `/api/comments/{commentId}`       | session     | Редактировать комментарий              |
| `DELETE` | `/api/comments/{commentId}`       | session     | Удалить комментарий                    |
| `POST`   | `/api/tasks/{taskId}/checklist`   | session     | Добавить пункт чеклиста                |
| `PATCH`  | `/api/checklist/{itemId}`         | session     | Обновить пункт (toggle, текст)         |
| `DELETE` | `/api/checklist/{itemId}`         | session     | Удалить пункт                          |
| `POST`   | `/api/tasks/{taskId}/attachments` | session     | Загрузить вложение. FormData: `file`   |
| `DELETE` | `/api/attachments/{attachmentId}` | session     | Удалить вложение                       |

### Клиенты (CRM contacts)

| Метод   | Путь                             | Авторизация | Описание                    |
| ------- | -------------------------------- | ----------- | --------------------------- |
| `GET`   | `/api/workspaces/{id}/customers` | session     | Список клиентов workspace-а |
| `GET`   | `/api/customers/{customerId}`    | session     | Клиент по ID                |
| `PATCH` | `/api/customers/{customerId}`    | session     | Обновить клиента            |

### Лейблы

| Метод | Путь                          | Авторизация | Описание       |
| ----- | ----------------------------- | ----------- | -------------- |
| `GET` | `/api/workspaces/{id}/labels` | session     | Список лейблов |

---

## 3. Knowledge Base

Разделен на два уровня:

- **Workspace-scoped** (`/api/workspaces/{id}/kb/...`) -- создание, списки, импорт
- **Entity-scoped** (`/api/kb/...`) -- операции над конкретными записями

### Статьи

| Метод    | Путь                                               | Авторизация | Описание                                                                                              |
| -------- | -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/kb/articles`                 | session     | Список статей. Query: `page`, `pageSize`, `categoryId`, `tagIds`, `authorId`, `isPublished`, `search` |
| `POST`   | `/api/workspaces/{id}/kb/articles`                 | session     | Создать статью. Body: `{ title, content, categoryId?, tagIds?, isPublished? }`                        |
| `GET`    | `/api/kb/articles/{articleId}`                     | session     | Получить статью по ID                                                                                 |
| `PATCH`  | `/api/kb/articles/{articleId}`                     | session     | Обновить статью                                                                                       |
| `DELETE` | `/api/kb/articles/{articleId}`                     | session     | Удалить статью                                                                                        |
| `GET`    | `/api/kb/articles/{articleId}/history`             | session     | История версий статьи                                                                                 |
| `POST`   | `/api/kb/articles/{articleId}/refresh`             | session     | Переимпортировать из URL. Body: `{ preview? }`                                                        |
| `POST`   | `/api/kb/articles/{articleId}/restore/{versionId}` | session     | Откатить к указанной версии                                                                           |

### Категории

| Метод    | Путь                                         | Авторизация | Описание                                            |
| -------- | -------------------------------------------- | ----------- | --------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/kb/categories`         | session     | Список категорий                                    |
| `POST`   | `/api/workspaces/{id}/kb/categories`         | session     | Создать категорию. Body: `{ name, description? }`   |
| `PATCH`  | `/api/workspaces/{id}/kb/categories/reorder` | session     | Изменить порядок. Body: `{ categoryIds: string[] }` |
| `PATCH`  | `/api/kb/categories/{categoryId}`            | session     | Обновить категорию                                  |
| `DELETE` | `/api/kb/categories/{categoryId}`            | session     | Удалить категорию                                   |

### Теги

| Метод    | Путь                           | Авторизация | Описание                              |
| -------- | ------------------------------ | ----------- | ------------------------------------- |
| `GET`    | `/api/workspaces/{id}/kb/tags` | session     | Список тегов. Query: `search`         |
| `POST`   | `/api/workspaces/{id}/kb/tags` | session     | Создать тег. Body: `{ name, color? }` |
| `DELETE` | `/api/kb/tags/{tagId}`         | session     | Удалить тег                           |

### Файлы

| Метод    | Путь                              | Авторизация | Описание                                    |
| -------- | --------------------------------- | ----------- | ------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/kb/files`   | session     | Список файлов workspace-а                   |
| `POST`   | `/api/workspaces/{id}/kb/files`   | session     | Загрузить файл. FormData: `file`            |
| `DELETE` | `/api/kb/files/{fileId}`          | session     | Удалить файл                                |
| `GET`    | `/api/kb/files/{fileId}/download` | session     | Скачать файл (binary stream)                |
| `GET`    | `/api/kb/files/{fileId}/preview`  | session     | Превью файла (текст/изображение/DOCX->HTML) |

### Импорт

| Метод  | Путь                                         | Авторизация | Описание                                                                                               |
| ------ | -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/workspaces/{id}/kb/import/url`         | session     | Импорт статьи из URL. Body: `{ url, categoryId?, tagIds? }`                                            |
| `POST` | `/api/workspaces/{id}/kb/import/url/preview` | session     | Предпросмотр URL перед импортом. Body: `{ url }`                                                       |
| `POST` | `/api/workspaces/{id}/kb/import/file`        | session     | Импорт из файла (MD/TXT/DOCX/PDF). FormData: `file`, `categoryId?`, `tagIds?`                          |
| `POST` | `/api/workspaces/{id}/kb/import/crawl`       | session     | Запустить краулинг сайта. Body: `{ startUrl, maxPages?, maxDepth?, timeoutMs?, categoryId?, tagIds? }` |

### Краулинг

| Метод  | Путь                              | Авторизация | Описание                   |
| ------ | --------------------------------- | ----------- | -------------------------- |
| `GET`  | `/api/workspaces/{id}/kb/crawls`  | session     | Список краулов workspace-а |
| `GET`  | `/api/kb/crawls/{crawlId}`        | session     | Статус конкретного краула  |
| `POST` | `/api/kb/crawls/{crawlId}/cancel` | session     | Отменить краул             |

### Поиск

| Метод  | Путь                             | Авторизация | Описание                                                                                                                                      |
| ------ | -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/workspaces/{id}/kb/search` | session     | Полнотекстовый поиск. Body: `{ text?, categoryIds?, tagIds?, authorIds?, sourceTypes?, isPublished?, sortBy?, sortOrder?, page?, pageSize? }` |
| `GET`  | `/api/workspaces/{id}/kb/search` | session     | История поиска пользователя                                                                                                                   |

---

## 4. Tickets

### Workspace-scoped

| Метод  | Путь                                       | Авторизация | Описание                                                                                                                                             |
| ------ | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/workspaces/{id}/tickets`             | session     | Список тикетов. Query: `page`, `pageSize`, `status`, `priority`, `category`, `source`, `assigneeIds`, `search`, `slaBreached`, `sortBy`, `sortOrder` |
| `POST` | `/api/workspaces/{id}/tickets`             | session     | Создать тикет. Body: `{ title, description, category?, priority?, source?, customerEmail?, customerName?, customerId? }`                             |
| `GET`  | `/api/workspaces/{id}/tickets/analytics`   | session     | Аналитика тикетов (SLA, категории, приоритеты)                                                                                                       |
| `POST` | `/api/workspaces/{id}/tickets/bulk-delete` | ADMIN       | Массовое удаление. Body: `{ ticketIds: string[] }`                                                                                                   |

### Операции над тикетом

| Метод    | Путь                               | Авторизация | Описание                                                 |
| -------- | ---------------------------------- | ----------- | -------------------------------------------------------- | ------------- | ------------------ | ---------- | ------------------ |
| `GET`    | `/api/tickets/{ticketId}`          | session     | Тикет по ID (с сообщениями)                              |
| `PATCH`  | `/api/tickets/{ticketId}`          | session     | Обновить тикет. Body: `{ title?, category?, priority? }` |
| `DELETE` | `/api/tickets/{ticketId}`          | session     | Удалить тикет                                            |
| `POST`   | `/api/tickets/{ticketId}/status`   | session     | Сменить статус. Body: `{ status: "OPEN"                  | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED", note? }` |
| `POST`   | `/api/tickets/{ticketId}/assign`   | session     | Назначить исполнителя. Body: `{ assigneeId: string       | null }`       |
| `POST`   | `/api/tickets/{ticketId}/messages` | session     | Добавить сообщение. Body: `{ content }`                  |

### Коллабораторы

| Метод    | Путь                                             | Авторизация | Описание                                                       |
| -------- | ------------------------------------------------ | ----------- | -------------------------------------------------------------- | ---------- | ------------- |
| `POST`   | `/api/tickets/{ticketId}/collaborators`          | session     | Добавить коллаборатора. Body: `{ userId, role?: "collaborator" | "reviewer" | "observer" }` |
| `DELETE` | `/api/tickets/{ticketId}/collaborators/{userId}` | session     | Удалить коллаборатора                                          |

### AI-агент

| Метод  | Путь                                   | Авторизация | Описание              |
| ------ | -------------------------------------- | ----------- | --------------------- |
| `POST` | `/api/tickets/{ticketId}/ai/suggest`   | session     | AI-предложение ответа |
| `POST` | `/api/tickets/{ticketId}/ai/summarize` | session     | AI-резюме тикета      |

### Конфигурация агента

| Метод    | Путь                                                | Авторизация | Описание                                                                                                                                                                      |
| -------- | --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/agent/config`                 | session     | Получить конфигурацию AI-агента                                                                                                                                               |
| `PATCH`  | `/api/workspaces/{id}/agent/config`                 | session     | Обновить конфигурацию. Body: `{ enabled?, mode?, model?, temperature?, systemPrompt?, greeting?, guardrails?, handoffThreshold?, autoResolve?, autoFaq?, autoContactNotes? }` |
| `GET`    | `/api/workspaces/{id}/agent/scenarios`              | session     | Список сценариев агента                                                                                                                                                       |
| `POST`   | `/api/workspaces/{id}/agent/scenarios`              | session     | Создать сценарий. Body: `{ title, description, instruction }`                                                                                                                 |
| `DELETE` | `/api/workspaces/{id}/agent/scenarios/{scenarioId}` | session     | Удалить сценарий                                                                                                                                                              |

### Готовые ответы (Canned Responses)

| Метод    | Путь                                           | Авторизация | Описание                                                         |
| -------- | ---------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/canned-responses`        | session     | Список шаблонов                                                  |
| `POST`   | `/api/workspaces/{id}/canned-responses`        | session     | Создать шаблон. Body: `{ shortCode, title, content, category? }` |
| `PATCH`  | `/api/workspaces/{id}/canned-responses/{crId}` | session     | Обновить шаблон. Body: `{ title?, content?, category? }`         |
| `DELETE` | `/api/workspaces/{id}/canned-responses/{crId}` | session     | Удалить шаблон                                                   |

### Email

| Метод  | Путь                               | Авторизация | Описание              |
| ------ | ---------------------------------- | ----------- | --------------------- |
| `POST` | `/api/email/inbound/{workspaceId}` | webhook     | Inbound email webhook |

---

## 5. Chat (внутренний)

Telegram-подобный мессенджер внутри workspace-а.

### Каналы

| Метод    | Путь                                              | Авторизация | Описание                                                       |
| -------- | ------------------------------------------------- | ----------- | -------------------------------------------------------------- | ------------------------ |
| `GET`    | `/api/workspaces/{id}/chat-channels`              | session     | Список каналов (с unread count)                                |
| `POST`   | `/api/workspaces/{id}/chat-channels`              | session     | Создать канал. Body: `{ name, description?, type?: "PUBLIC"    | "PRIVATE", memberIds? }` |
| `GET`    | `/api/workspaces/{id}/chat-channels/search?q=...` | session     | Поиск сообщений по workspace-у. Query: `q` (минимум 2 символа) |
| `POST`   | `/api/workspaces/{id}/chat-channels/dm`           | session     | Открыть / создать личные сообщения. Body: `{ targetUserId }`   |
| `GET`    | `/api/workspaces/{id}/chat-channels/{channelId}`  | session     | Детали канала                                                  |
| `PATCH`  | `/api/workspaces/{id}/chat-channels/{channelId}`  | session     | Обновить канал. Body: `{ name?, description? }`                |
| `DELETE` | `/api/workspaces/{id}/chat-channels/{channelId}`  | ADMIN       | Удалить канал (кроме GENERAL)                                  |

### Участники канала

| Метод    | Путь                                                     | Авторизация | Описание                               |
| -------- | -------------------------------------------------------- | ----------- | -------------------------------------- |
| `POST`   | `/api/workspaces/{id}/chat-channels/{channelId}/members` | session     | Добавить участника. Body: `{ userId }` |
| `DELETE` | `/api/workspaces/{id}/chat-channels/{channelId}/members` | session     | Удалить участника. Body: `{ userId }`  |

### Сообщения

| Метод    | Путь                                                                  | Авторизация | Описание                                                                                              |
| -------- | --------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/chat-channels/{channelId}/messages`             | session     | Список сообщений. Query: `before?` (cursor), `limit?` (1-100, default 50)                             |
| `POST`   | `/api/workspaces/{id}/chat-channels/{channelId}/messages`             | session     | Отправить сообщение. Body: `{ content, parentId?, linkedTicketId?, linkedTaskId?, forwardedFromId? }` |
| `PATCH`  | `/api/workspaces/{id}/chat-channels/{channelId}/messages/{messageId}` | session     | Редактировать сообщение. Body: `{ content }`                                                          |
| `DELETE` | `/api/workspaces/{id}/chat-channels/{channelId}/messages/{messageId}` | session     | Удалить сообщение (автор или ADMIN)                                                                   |

### Действия с сообщениями

| Метод  | Путь                          | Авторизация | Описание                                              |
| ------ | ----------------------------- | ----------- | ----------------------------------------------------- |
| `POST` | `.../{messageId}/reactions`   | session     | Toggle реакции. Body: `{ emoji }`                     |
| `POST` | `.../{messageId}/pin`         | session     | Toggle закрепить/открепить                            |
| `POST` | `.../{messageId}/bookmark`    | session     | Toggle закладка                                       |
| `POST` | `.../{messageId}/forward`     | session     | Переслать в другой канал. Body: `{ targetChannelId }` |
| `GET`  | `.../{messageId}/thread`      | session     | Ответы в треде                                        |
| `POST` | `.../{messageId}/attachments` | session     | Загрузить вложение (макс 20 МБ). FormData: `file`     |

> Полный путь: `/api/workspaces/{id}/chat-channels/{channelId}/messages/{messageId}/...`

### Состояние канала

| Метод  | Путь                     | Авторизация | Описание                              |
| ------ | ------------------------ | ----------- | ------------------------------------- |
| `POST` | `.../{channelId}/read`   | session     | Отметить канал прочитанным            |
| `POST` | `.../{channelId}/mute`   | session     | Toggle mute канала                    |
| `GET`  | `.../{channelId}/pinned` | session     | Список закрепленных сообщений         |
| `POST` | `.../{channelId}/typing` | session     | Индикатор "печатает..."               |
| `GET`  | `.../{channelId}/typing` | session     | Кто сейчас печатает (последние 5 сек) |

> Полный путь: `/api/workspaces/{id}/chat-channels/{channelId}/...`

### Публичный чат -- настройки (admin-сторона)

| Метод   | Путь                                 | Авторизация | Описание                                                                                                                                                                      |
| ------- | ------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/workspaces/{id}/chat/settings` | session     | Получить настройки публичного чата                                                                                                                                            |
| `PATCH` | `/api/workspaces/{id}/chat/settings` | session     | Обновить настройки. Body: `{ chatTitle?, chatSubtitle?, chatAccentColor?, chatLogoUrl?, chatIdentityMethod?, chatPersonaRotation?, chatAllowedEmbedOrigins?, chatTimezone? }` |

### Персоны чата

| Метод    | Путь                                                    | Авторизация | Описание                                                                           |
| -------- | ------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/chat/personas`                    | session     | Список персон                                                                      |
| `POST`   | `/api/workspaces/{id}/chat/personas`                    | session     | Создать персону. Body: `{ displayName, role, bio?, avatarUrl? }`                   |
| `PATCH`  | `/api/workspaces/{id}/chat/personas/{personaId}`        | session     | Обновить персону. Body: `{ displayName?, role?, bio?, avatarUrl?, scheduleDays? }` |
| `DELETE` | `/api/workspaces/{id}/chat/personas/{personaId}`        | session     | Удалить персону                                                                    |
| `POST`   | `/api/workspaces/{id}/chat/personas/{personaId}/avatar` | session     | Загрузить аватар персоны (макс 2 МБ). FormData: `file`                             |
| `POST`   | `/api/workspaces/{id}/chat/personas/reorder`            | session     | Изменить порядок персон. Body: `{ personaIds: string[] }`                          |

---

## 6. Chat (публичный виджет)

Виджет для клиентов. Авторизация через JWT-токен (Bearer), полученный при `/identify`.
Все эндпоинты поддерживают CORS.

| Метод  | Путь                                           | Авторизация | Описание                                                                                                                                            |
| ------ | ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/chat/{slug}/config`                      | public      | Конфигурация чата (персоны, цвета, заголовок). Кэш 5 мин                                                                                            |
| `POST` | `/api/chat/{slug}/identify`                    | public      | Идентификация клиента. Body: `{ method, email?, name?, telegramChatId?, telegramName? }`. Возвращает `{ customer, token, csrf }`. Rate limit: 5/мин |
| `GET`  | `/api/chat/{slug}/tickets`                     | JWT         | Список тикетов клиента                                                                                                                              |
| `POST` | `/api/chat/{slug}/tickets`                     | JWT+CSRF    | Создать тикет. Body: `{ title, description, category? }`. Rate limit: 30/мин                                                                        |
| `GET`  | `/api/chat/{slug}/tickets/{ticketId}`          | JWT         | Тикет клиента по ID                                                                                                                                 |
| `POST` | `/api/chat/{slug}/tickets/{ticketId}/messages` | JWT+CSRF    | Отправить сообщение. Body: `{ content }`. Rate limit: 60/мин                                                                                        |
| `GET`  | `/api/chat/{slug}/tickets/{ticketId}/rate`     | JWT         | Получить оценку тикета                                                                                                                              |
| `POST` | `/api/chat/{slug}/tickets/{ticketId}/rate`     | JWT         | Оценить тикет (CSAT). Body: `{ score: 1-5, comment? }`                                                                                              |
| `GET`  | `/api/chat/avatars/{...path}`                  | public      | Статика аватаров                                                                                                                                    |

---

## 7. Marketing (AI Outreach)

Полный пайплайн AI-аутрича: парсинг -> лиды -> скоринг -> AI-питч -> ревью -> отправка -> IMAP -> AI-ответ.

### Конфигурация

| Метод   | Путь                                    | Авторизация | Описание                                                                             |
| ------- | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `GET`   | `/api/workspaces/{id}/marketing/config` | session     | Получить конфигурацию (API-ключи, лимиты, скоринг). Чувствительные поля расшифрованы |
| `PATCH` | `/api/workspaces/{id}/marketing/config` | session     | Обновить конфигурацию. Чувствительные поля шифруются AES-256-GCM                     |

### Проекты (кампании)

| Метод    | Путь                                                           | Авторизация | Описание            |
| -------- | -------------------------------------------------------------- | ----------- | ------------------- |
| `GET`    | `/api/workspaces/{id}/marketing/projects`                      | session     | Список проектов     |
| `POST`   | `/api/workspaces/{id}/marketing/projects`                      | session     | Создать проект      |
| `GET`    | `/api/workspaces/{id}/marketing/projects/{projectId}`          | session     | Проект по ID        |
| `PATCH`  | `/api/workspaces/{id}/marketing/projects/{projectId}`          | session     | Обновить проект     |
| `DELETE` | `/api/workspaces/{id}/marketing/projects/{projectId}`          | session     | Удалить проект      |
| `POST`   | `/api/workspaces/{id}/marketing/projects/{projectId}/activate` | session     | Активировать проект |

### Лиды

| Метод    | Путь                                            | Авторизация | Описание                                                                                      |
| -------- | ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/marketing/leads`          | session     | Список лидов. Query: `status`, `stage`, `source`, `search`, `scoreLevel`, `limit`, `offset`   |
| `POST`   | `/api/workspaces/{id}/marketing/leads`          | session     | Создать лида вручную. Body: `{ channelName, source, channelUrl?, email?, telegram?, notes? }` |
| `GET`    | `/api/workspaces/{id}/marketing/leads/{leadId}` | session     | Лид по ID                                                                                     |
| `PATCH`  | `/api/workspaces/{id}/marketing/leads/{leadId}` | session     | Обновить лида. Body: `{ leadStatus?, notes?, projectId? }`                                    |
| `DELETE` | `/api/workspaces/{id}/marketing/leads/{leadId}` | session     | Удалить лида                                                                                  |
| `POST`   | `/api/workspaces/{id}/marketing/leads/bulk`     | session     | Массовое обновление статуса. Body: `{ leadIds: string[], status }`                            |
| `POST`   | `/api/workspaces/{id}/marketing/leads/score`    | session     | AI-скоринг. Body: `{ leadId? }` (если нет -- скорить все)                                     |

### Диалоги

| Метод | Путь                                                    | Авторизация | Описание                                 |
| ----- | ------------------------------------------------------- | ----------- | ---------------------------------------- |
| `GET` | `/api/workspaces/{id}/marketing/dialogues`              | session     | Список диалогов (с последним сообщением) |
| `GET` | `/api/workspaces/{id}/marketing/dialogues/{dialogueId}` | session     | Диалог с полной перепиской               |

### Сделки

| Метод  | Путь                                            | Авторизация | Описание                                         |
| ------ | ----------------------------------------------- | ----------- | ------------------------------------------------ | --------------------- |
| `GET`  | `/api/workspaces/{id}/marketing/deals`          | session     | Список сделок. Query: `status?`                  |
| `POST` | `/api/workspaces/{id}/marketing/deals/{dealId}` | session     | Решение по сделке. Body: `{ decision: "APPROVED" | "REJECTED", notes? }` |

### Ожидающие ответы (Review Mode)

| Метод  | Путь                                               | Авторизация | Описание                                       |
| ------ | -------------------------------------------------- | ----------- | ---------------------------------------------- | -------- | ------------------------------------------------ |
| `GET`  | `/api/workspaces/{id}/marketing/pending`           | session     | Список ответов на ревью. Query: `status?`      |
| `POST` | `/api/workspaces/{id}/marketing/pending/{replyId}` | session     | Действие с ответом. Body: `{ action: "approve" | "reject" | "delete", editedBody?, editedSubject?, notes? }` |

### Worker (фоновый процесс)

| Метод  | Путь                                         | Авторизация | Описание                                       |
| ------ | -------------------------------------------- | ----------- | ---------------------------------------------- | --------- |
| `GET`  | `/api/workspaces/{id}/marketing/worker`      | session     | Статус worker-а                                |
| `POST` | `/api/workspaces/{id}/marketing/worker`      | session     | Управление worker-ом. Body: `{ action: "start" | "stop" }` |
| `GET`  | `/api/workspaces/{id}/marketing/worker/logs` | session     | Логи worker-а (in-memory)                      |

### Парсеры (YouTube)

| Метод    | Путь                                                    | Авторизация | Описание                                             |
| -------- | ------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/marketing/parsers/tasks`          | session     | Список задач парсера                                 |
| `POST`   | `/api/workspaces/{id}/marketing/parsers/tasks`          | session     | Создать задачу парсера                               |
| `PATCH`  | `/api/workspaces/{id}/marketing/parsers/tasks/{taskId}` | session     | Обновить задачу                                      |
| `DELETE` | `/api/workspaces/{id}/marketing/parsers/tasks/{taskId}` | session     | Удалить задачу                                       |
| `POST`   | `/api/workspaces/{id}/marketing/parsers/run`            | session     | Запустить парсер (фоновый). Body: настройки парсинга |
| `GET`    | `/api/workspaces/{id}/marketing/parsers/run`            | session     | Статус текущего парсинга (running, logs, result)     |
| `GET`    | `/api/workspaces/{id}/marketing/parsers/runs`           | session     | История запусков. Query: `limit?`                    |

### Сегменты и шаблоны

| Метод  | Путь                                       | Авторизация | Описание                                                                      |
| ------ | ------------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `GET`  | `/api/workspaces/{id}/marketing/segments`  | session     | Список сегментов                                                              |
| `POST` | `/api/workspaces/{id}/marketing/segments`  | session     | Создать сегмент. Body: `{ name, filters? }`                                   |
| `GET`  | `/api/workspaces/{id}/marketing/templates` | session     | Список email-шаблонов                                                         |
| `POST` | `/api/workspaces/{id}/marketing/templates` | session     | Создать шаблон. Body: `{ name, channel, language, subject, body, category? }` |

### Аналитика

| Метод | Путь                                       | Авторизация | Описание                                                 |
| ----- | ------------------------------------------ | ----------- | -------------------------------------------------------- |
| `GET` | `/api/workspaces/{id}/marketing/analytics` | session     | Статистика: лиды по источникам/статусам, затраты, сделки |

---

## 8. Voice (WebRTC)

WebRTC mesh аудио с TURN, screen share, гостевым доступом, записью и AI-сводкой.

### Комнаты

| Метод    | Путь                                        | Авторизация | Описание                                                       |
| -------- | ------------------------------------------- | ----------- | -------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/voice/rooms`          | session     | Список комнат (автосоздание дефолтной). Приватные фильтруются  |
| `POST`   | `/api/workspaces/{id}/voice/rooms`          | session     | Создать комнату. Body: `{ name, isPrivate?, allowedUserIds? }` |
| `PATCH`  | `/api/workspaces/{id}/voice/rooms/{roomId}` | session     | Переименовать. Body: `{ name }`                                |
| `DELETE` | `/api/workspaces/{id}/voice/rooms/{roomId}` | session     | Удалить комнату (кроме дефолтной)                              |

### Участники

| Метод    | Путь                                                     | Авторизация    | Описание                                                            |
| -------- | -------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/workspaces/{id}/voice/rooms/{roomId}/participants` | public         | Список участников (гости тоже видят). Stale > 30 сек удаляются      |
| `POST`   | `/api/workspaces/{id}/voice/rooms/{roomId}/participants` | session/public | Войти в комнату. Body: `{ guestName?, guestToken? }` (для гостей)   |
| `DELETE` | `/api/workspaces/{id}/voice/rooms/{roomId}/participants` | session/public | Выйти из комнаты. При пустой комнате -- закрытие сессии + AI-сводка |

### Heartbeat

| Метод   | Путь                                                  | Авторизация    | Описание                                                                            |
| ------- | ----------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `PATCH` | `/api/workspaces/{id}/voice/rooms/{roomId}/heartbeat` | session/public | Обновить heartbeat + состояние. Body: `{ isMuted?, isScreenSharing?, guestToken? }` |

### Сигнализация (WebRTC)

| Метод  | Путь                                               | Авторизация | Описание                                                                 |
| ------ | -------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `GET`  | `/api/workspaces/{id}/voice/rooms/{roomId}/signal` | session     | Получить непрочитанные сигналы (offer/answer/ICE). Помечает как consumed |
| `POST` | `/api/workspaces/{id}/voice/rooms/{roomId}/signal` | session     | Отправить сигнал. Body: `{ toUserId, type, payload }`                    |

### Чат в комнате

| Метод  | Путь                                                 | Авторизация    | Описание                                             |
| ------ | ---------------------------------------------------- | -------------- | ---------------------------------------------------- |
| `GET`  | `/api/workspaces/{id}/voice/rooms/{roomId}/messages` | public         | Последние 50 сообщений                               |
| `POST` | `/api/workspaces/{id}/voice/rooms/{roomId}/messages` | session/public | Отправить сообщение. Body: `{ content, guestName? }` |

### Запись и AI-сводка

| Метод  | Путь                                                  | Авторизация | Описание                                                                                |
| ------ | ----------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `POST` | `/api/workspaces/{id}/voice/rooms/{roomId}/recording` | session     | Загрузить запись звонка. FormData: `file`, `sessionId?`. Groq Whisper -> Claude summary |

### Сессии и приглашения

| Метод  | Путь                                  | Авторизация | Описание                                           |
| ------ | ------------------------------------- | ----------- | -------------------------------------------------- |
| `GET`  | `/api/workspaces/{id}/voice/sessions` | session     | История голосовых сессий. Query: `page?`, `limit?` |
| `POST` | `/api/workspaces/{id}/voice/invite`   | session     | Сгенерировать гостевую ссылку. Body: `{ roomId }`  |

### ICE-серверы

| Метод | Путь                     | Авторизация | Описание                                                |
| ----- | ------------------------ | ----------- | ------------------------------------------------------- |
| `GET` | `/api/voice/ice-servers` | session     | Конфигурация STUN/TURN серверов (Metered/custom/Twilio) |

---

## 9. Logs

### Activity Logs (действия пользователей)

| Метод | Путь                                 | Авторизация | Описание                                                                                               |
| ----- | ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------ |
| `GET` | `/api/workspaces/{id}/logs/activity` | session     | Лог действий. Query: `page`, `pageSize`, `from?`, `to?`, `actions?`, `actorIds?`, `taskId?`, `search?` |
| `GET` | `/api/logs/activity`                 | session     | Глобальный лог действий (аналогичные фильтры)                                                          |

### System Logs

| Метод | Путь                               | Авторизация | Описание                                                                                               |
| ----- | ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `GET` | `/api/workspaces/{id}/logs/system` | session     | Системные логи. Query: `page`, `pageSize`, `from?`, `to?`, `level?` (`INFO`/`WARN`/`ERROR`), `source?` |

---

## 10. Global Chat

Кросс-workspace мессенджер для всех авторизованных пользователей.

| Метод    | Путь                                       | Авторизация | Описание                                            |
| -------- | ------------------------------------------ | ----------- | --------------------------------------------------- |
| `GET`    | `/api/global-chat`                         | session     | Сообщения (cursor pagination). Query: `before?`     |
| `POST`   | `/api/global-chat`                         | session     | Отправить сообщение. Body: `{ content, parentId? }` |
| `PATCH`  | `/api/global-chat/{messageId}`             | session     | Редактировать (только автор). Body: `{ content }`   |
| `DELETE` | `/api/global-chat/{messageId}`             | session     | Удалить (автор или ADMIN). Soft delete              |
| `POST`   | `/api/global-chat/{messageId}/reactions`   | session     | Toggle реакции. Body: `{ emoji }`                   |
| `POST`   | `/api/global-chat/{messageId}/attachments` | session     | Загрузить вложение (макс 20 МБ). FormData: `file`   |

### Вложения (скачивание)

| Метод | Путь                                | Авторизация | Описание                          |
| ----- | ----------------------------------- | ----------- | --------------------------------- |
| `GET` | `/api/global-chat-attachments/{id}` | session     | Скачать вложение глобального чата |
| `GET` | `/api/chat-attachments/{id}`        | session     | Скачать вложение внутреннего чата |

---

## 11. Notifications

| Метод  | Путь                              | Авторизация | Описание                                                    |
| ------ | --------------------------------- | ----------- | ----------------------------------------------------------- |
| `GET`  | `/api/notifications`              | session     | Список уведомлений. Query: `unreadOnly?`, `page?`, `limit?` |
| `POST` | `/api/notifications/read`         | session     | Отметить уведомления прочитанными                           |
| `GET`  | `/api/notifications/unread-count` | session     | Количество непрочитанных                                    |
| `GET`  | `/api/notifications/chat-updates` | session     | SSE-стрим обновлений чата                                   |

---

## 12. Admin

Все эндпоинты требуют `session` с ролью `ADMIN`.

| Метод   | Путь                                       | Описание                                                                           |
| ------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET`   | `/api/admin/users`                         | Список пользователей. Query: `page?`, `pageSize?`, `search?`                       |
| `POST`  | `/api/admin/users`                         | Создать пользователя. Body: `{ login, email, role? }`. Возвращает временный пароль |
| `PATCH` | `/api/admin/users/{userId}/activate`       | Активировать аккаунт                                                               |
| `PATCH` | `/api/admin/users/{userId}/deactivate`     | Деактивировать аккаунт (нельзя самого себя)                                        |
| `PATCH` | `/api/admin/users/{userId}/role`           | Сменить роль. Body: `{ role }` (нельзя менять себе)                                |
| `POST`  | `/api/admin/users/{userId}/reset-password` | Сбросить пароль. Возвращает временный пароль                                       |

---

## 13. Profile

Все эндпоинты привязаны к текущей сессии (нет параметра userId).

| Метод   | Путь                         | Авторизация | Описание                                                 |
| ------- | ---------------------------- | ----------- | -------------------------------------------------------- |
| `POST`  | `/api/profile/avatar`        | session     | Загрузить аватар (макс 5 МБ). FormData: `file`           |
| `PATCH` | `/api/profile/password`      | session     | Сменить пароль. Body: `{ currentPassword, newPassword }` |
| `GET`   | `/api/profile/notifications` | session     | Получить настройки уведомлений (звук, десктоп)           |
| `PATCH` | `/api/profile/notifications` | session     | Обновить настройки уведомлений                           |

### Telegram

| Метод   | Путь                                  | Авторизация | Описание                            |
| ------- | ------------------------------------- | ----------- | ----------------------------------- |
| `POST`  | `/api/profile/telegram/generate-code` | session     | Сгенерировать код привязки Telegram |
| `GET`   | `/api/profile/telegram/status`        | session     | Статус привязки                     |
| `POST`  | `/api/profile/telegram/disconnect`    | session     | Отвязать Telegram                   |
| `GET`   | `/api/profile/telegram/preferences`   | session     | Настройки TG-уведомлений            |
| `PATCH` | `/api/profile/telegram/preferences`   | session     | Обновить настройки TG-уведомлений   |

---

## 14. Users (система)

| Метод  | Путь                         | Авторизация | Описание                 |
| ------ | ---------------------------- | ----------- | ------------------------ |
| `GET`  | `/api/users/all`             | session     | Все пользователи системы |
| `GET`  | `/api/users/search`          | session     | Поиск пользователей      |
| `GET`  | `/api/users/online`          | session     | Онлайн-пользователи      |
| `POST` | `/api/users/heartbeat`       | session     | Heartbeat online-статуса |
| `GET`  | `/api/users/{userId}/avatar` | session     | Аватар пользователя      |

---

## 15. External Users

Модуль подключения внешних пользователей через API-прокси.

| Метод  | Путь                                                 | Авторизация | Описание                                 |
| ------ | ---------------------------------------------------- | ----------- | ---------------------------------------- |
| `GET`  | `/api/workspaces/{id}/external-users`                | session     | Конфигурация подключения                 |
| `POST` | `/api/workspaces/{id}/external-users`                | session     | Создать/обновить конфигурацию            |
| `GET`  | `/api/workspaces/{id}/external-users/proxy?path=...` | session     | Проксирование к внешнему API. Кэш 60 сек |

---

## 16. Служебные

| Метод  | Путь                  | Авторизация           | Описание                                                            |
| ------ | --------------------- | --------------------- | ------------------------------------------------------------------- |
| `GET`  | `/api/health`         | public                | Health check (проверка БД). `{ status: "ok", timestamp }` или `503` |
| `POST` | `/api/deploy/webhook` | webhook (HMAC-SHA256) | GitHub push webhook -- запуск деплоя + TG-уведомления               |
| `POST` | `/api/transcribe`     | session               | Транскрипция аудио (Groq Whisper). FormData: `file`                 |
| `GET`  | `/api/link-preview`   | session               | Превью ссылки (OG-метатеги)                                         |
| `GET`  | `/api/bookmarks`      | session               | Закладки текущего пользователя                                      |
