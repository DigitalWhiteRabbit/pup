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

- **crm** — kanban, tasks, labels, time tracking, drag-drop (Phases 1-8 + R1)
- **knowledge** — articles, files, crawl, search, SSRF protection (KB-1a/1b/1c)
- **tickets** — CRUD + SLA, public chat, canned responses, CSAT, AI agent (1a/1b/1c/1d)
- **chat** — channels, DM, replies, reactions, @mentions, voice messages, transcription
- **marketing** — AI outreach pipeline, YouTube parser, email, IMAP, TG outreach
- **users** — external API connector, 10-tab UI
- **logs** — stats, timeline, diff view, system events, filters
- **analytics** — voice channels: WebRTC mesh, rooms, screen share, AI summary, guest join

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

## Working style

- Для аудитов, исследований и разработки **ОБЯЗАТЕЛЬНО используй субагентов** (Task-агентов): разбивай работу и запускай их **ПАРАЛЛЕЛЬНО** (fan-out), затем синтезируй результат. Не делай большие обзоры в одиночку линейно.
- Используй доступные **скиллы (skills)** где уместно: `security-review` для аудита безопасности, `review` для разбора изменений, и др.
- Большие задачи делай **тщательно и многопроходно**, а не поверхностно.

_(EN) For audits, research, and development you MUST use subagents (Task agents): split the work and run them IN PARALLEL (fan-out), then synthesize. Don't do large reviews linearly on your own. Use available skills where relevant (`security-review` for security audits, `review` for change review, etc.). Do large tasks thoroughly and in multiple passes, not superficially._
