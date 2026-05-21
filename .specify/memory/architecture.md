# ПУП Architecture

## Concept

ПУП (Пульт Управления Проектами) — multi-module platform. Top-level entity is **Workspace**. Each workspace has 8 modules.

## 8 Modules

| key       | Label                | Status         | Description                                                                                                             |
| --------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| crm       | CRM-доска            | ✅ Implemented | Kanban-доска с задачами, метками, учётом времени, drag-and-drop (Phase 1-8 + R1)                                        |
| knowledge | База знаний          | ✅ Implemented | Статьи, загрузка файлов (PDF/DOCX/XLSX), веб-краулинг, полнотекстовый поиск, SSRF-защита (KB-1a/1b/1c)                  |
| tickets   | Тикеты               | ✅ Implemented | CRUD + SLA, публичный чат-виджет, шаблоны ответов (canned), CSAT, email-нотификации, AI-агент (1a/1b/1c/1d)             |
| chat      | Чат                  | ✅ Implemented | Каналы, личные сообщения, ответы, реакции, @упоминания, редактирование/удаление, голосовые сообщения, транскрипция      |
| marketing | Маркетинг            | ✅ Implemented | AI-аутрич-пайплайн: парсинг YouTube-лидов, скоринг, AI-питчи (Claude), email через Resend, IMAP-ответы, Telegram-аутрич |
| users     | Пользователи проекта | ✅ Implemented | Внешний API-коннектор, 10-табовый UI (проксирование внешнего API)                                                       |
| logs      | Логи                 | ✅ Implemented | Статистика, таймлайн событий, diff-просмотр, системная вкладка, фильтры                                                 |
| analytics | Аналитика            | ✅ Implemented | Голосовые каналы: WebRTC mesh-аудио, комнаты, демонстрация экрана, AI-резюме, гостевой доступ                           |

## URL Structure

```
/workspaces                        — list of workspaces
/workspaces/[id]                   — workspace overview (modules grid + members + settings)
/workspaces/[id]/crm               — CRM kanban board
/workspaces/[id]/knowledge         — knowledge base (articles, files, search)
/workspaces/[id]/tickets           — ticket system (SLA, chat widget, AI agent)
/workspaces/[id]/chat              — internal messenger (channels, DM, voice messages)
/workspaces/[id]/marketing         — AI outreach pipeline (leads, pitches, email, IMAP)
/workspaces/[id]/users             — external API connector (10-tab UI)
/workspaces/[id]/logs              — activity logs (stats, timeline, diffs)
/workspaces/[id]/analytics         — voice channels (WebRTC rooms, screen share)
```

## Adding a New Module (checklist)

1. Add `moduleKey` to `DEFAULT_MODULES` in `workspace.service.ts`
2. Add metadata to `MODULE_META` in `PlaceholderModule.tsx`, `workspace-overview-client.tsx`, `Sidebar.tsx`
3. Add to `MODULE_ORDER` arrays in those files
4. Create `app/(authenticated)/workspaces/[id]/<key>/page.tsx` with membership + isModuleEnabled check
5. New seed data will auto-include via `DEFAULT_MODULES.map()`

## Sidebar Logic

- **Global mode**: pathname = `/workspaces` or `/admin/*` or `/settings/*` → shows Workspaces, Settings, Admin
- **Contextual mode**: pathname starts with `/workspaces/[id]/` → shows workspace name + enabled modules + workspace settings link

## Key Files

- `lib/services/workspace.service.ts` — all workspace/module/column business logic
- `lib/schemas/workspace.schema.ts` — Zod schemas
- `app/api/workspaces/` — all workspace API routes
- `components/PlaceholderModule.tsx` — reusable stub for unimplemented modules
- `components/layout/Sidebar.tsx` — two-level navigation
