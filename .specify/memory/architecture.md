# ПУП Architecture

## Concept

ПУП (Пульт Управления Проектами) — multi-module platform. Top-level entity is **Workspace**. Each workspace has 8 modules.

## 8 Modules

| key       | Label                | Status                          |
| --------- | -------------------- | ------------------------------- |
| crm       | CRM-доска            | ✅ Implemented (Phase 1-8 + R1) |
| knowledge | База знаний          | 🔲 Placeholder                  |
| tickets   | Тикеты               | 🔲 Placeholder                  |
| logs      | Логи                 | 🔲 Placeholder                  |
| chat      | Чат                  | 🔲 Placeholder                  |
| marketing | Маркетинг            | 🔲 Placeholder                  |
| analytics | Аналитика            | 🔲 Placeholder                  |
| users     | Пользователи проекта | 🔲 Placeholder                  |

## URL Structure

```
/workspaces                        — list of workspaces
/workspaces/[id]                   — workspace overview (modules grid + members + settings)
/workspaces/[id]/crm               — CRM kanban board
/workspaces/[id]/knowledge         — placeholder
/workspaces/[id]/tickets           — placeholder
/workspaces/[id]/logs              — placeholder
/workspaces/[id]/chat              — placeholder
/workspaces/[id]/marketing         — placeholder
/workspaces/[id]/analytics         — placeholder
/workspaces/[id]/users             — placeholder
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
