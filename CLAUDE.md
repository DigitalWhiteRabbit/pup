<!-- SPECKIT START -->

# ПУП — Пульт Управления Проектами

Multi-module platform. Top-level entity: **Workspace**. Each workspace contains 8 modules.
Current branch: 001-crm-kanban-system (Phase R1 refactor complete).

## Architecture

- Workspace = рабочее пространство (бывший Project)
- 8 modules per workspace: crm, knowledge, tickets, logs, chat, marketing, analytics, users
- URL structure: /workspaces/[id]/<moduleKey>
- See .specify/memory/architecture.md for full details

## Active modules

- **crm** — fully implemented (Phases 1-8 + R1)
- others — placeholders (redirect to overview if disabled)

## Key services

- lib/services/workspace.service.ts — workspace + columns + modules
- lib/services/task.service.ts — tasks (uses workspaceId)
- lib/services/notification.service.ts — in-app + Telegram

## Tech stack

Next.js 14 App Router · TypeScript strict · Prisma (SQLite dev / PostgreSQL prod)
shadcn/ui · TanStack Query · dnd-kit · next-auth · Telegram Bot API

## Shell commands

- pnpm dev — start dev server
- pnpm db:migrate — run migrations
- pnpm db:seed — seed admin user
- SEED_DEMO_DATA=true pnpm db:seed — seed admin + demo workspace + 8 modules
- pnpm typecheck — TypeScript check
- pnpm lint — ESLint
- pnpm test — run tests

## Original CRM spec artifacts

- Spec: specs/001-crm-kanban-system/spec.md
- Plan: specs/001-crm-kanban-system/plan.md
- Data model: specs/001-crm-kanban-system/data-model.md
- API contracts: specs/001-crm-kanban-system/contracts/api.md
- Quickstart: specs/001-crm-kanban-system/quickstart.md
<!-- SPECKIT END -->
