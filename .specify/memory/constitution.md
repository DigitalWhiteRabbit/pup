<!--
SYNC IMPACT REPORT
==================
Version change: [template] → 1.0.0
Modified principles: N/A (initial ratification — all placeholders replaced)
Added sections:
  - Technical Principles (7 principles)
  - Architectural Principles (3 principles)
  - Development Process (5 principles)
  - UX/UI Principles (3 principles)
  - Performance (2 principles)
  - Governance
Removed sections: N/A
Templates requiring updates:
  ✅ .specify/templates/plan-template.md — Constitution Check section references CRM-specific gates
  ✅ .specify/templates/spec-template.md — no structural change needed; principles self-contained
  ✅ .specify/templates/tasks-template.md — no structural change needed
Deferred TODOs:
  - RATIFICATION_DATE set to 2026-05-05 (today, first ratification)
-->

# CRM Constitution

## Technical Principles

### I. Package Manager — pnpm Only

All dependency management MUST use `pnpm`. The commands `npm install` and `yarn add` are
forbidden in this repository. CI pipelines and developer scripts MUST enforce pnpm.

**Rationale**: Ensures lockfile consistency, disk-efficient installs, and a single source
of truth for dependency resolution across all environments.

### II. TypeScript Strict Mode — No `any`

TypeScript MUST be configured with `strict: true`. The `any` type is forbidden.
When a truly dynamic type is needed, use `unknown` and narrow it via a Zod schema
before use.

**Rationale**: `any` silently disables type checking and is a primary source of runtime
errors. `unknown` + Zod gives the same flexibility with full safety guarantees.

### III. Zod Validation on All API Endpoints

Every API route MUST validate both request input and response output against explicit
Zod schemas. Unvalidated data MUST NOT pass the route boundary in either direction.

**Rationale**: Prevents malformed data from propagating through the system and documents
the contract for each endpoint in a machine-verifiable way.

### IV. No New Packages Without Justification

Before adding any new npm package, the developer MUST verify that the task cannot be
accomplished with existing dependencies. New packages require a written justification
(in the PR description) explaining why existing deps are insufficient.

**Rationale**: Keeps the dependency surface small, reduces supply-chain risk, and avoids
bloat from duplicate utility libraries.

### V. Database Backup Before Every Migration

Before running any Prisma migration in production, a `pg_dump` snapshot MUST be taken.
For local development environments, a copy of `dev.db` MUST be made before migrating.
No migration may proceed without a verified backup.

**Rationale**: Migrations are irreversible in most cases. A backup provides a safe
rollback path and protects against data loss from schema errors.

### VI. Server-Only Code Must Never Reach the Client

Prisma queries, secrets, and other server-only logic MUST be protected with the
`server-only` npm package. Importing these modules from a client component MUST cause
a build-time error.

**Rationale**: Prevents accidental leakage of database credentials, query logic, or
internal business rules to the browser bundle.

### VII. Secrets in `.env` Only — Never Committed

All secrets and environment-specific configuration MUST live in `.env` files. These files
MUST be listed in `.gitignore` and MUST never be committed. The repository MUST contain
an up-to-date `.env.example` as the canonical template.

**Rationale**: Committing secrets to git is an irreversible exposure. `.env.example`
ensures new developers can onboard without guesswork while secrets stay safe.

## Architectural Principles

### VIII. Business Logic Lives in `/lib/services/`

API routes MUST act as a thin validation + dispatch layer only. All business logic MUST
reside in `/lib/services/`. An API route MUST NOT contain domain logic directly.

**Rationale**: Keeps routes testable in isolation, allows business logic to be reused
across multiple transports (REST, cron, webhooks), and enforces clear separation of
concerns.

### IX. File Storage via `FileStorage` Abstraction

All file upload, download, and delete operations MUST go through the `FileStorage`
interface (methods: `upload`, `download`, `delete`). The current implementation is
`LocalStorage` writing to `./uploads/`. Adding S3 or another backend MUST require only
a new implementation class, not changes to call sites.

**Rationale**: Decouples application code from the storage backend, enabling future
migration to cloud storage without touching business logic.

### X. Notifications via `NotificationService`

All user-facing notifications MUST be sent through `NotificationService`, which
dispatches to two transports: in-app (persisted to the database) and Telegram.
Notification triggers MUST be defined in one place only — no direct transport calls
scattered across the codebase.

**Rationale**: A single source of truth for notification triggers prevents duplicate
messages, makes auditing straightforward, and allows transports to be toggled without
code changes.

## Development Process

### XI. Every Feature Follows the Full spec-kit Cycle

Each feature MUST go through the complete spec-kit workflow in order:
`specify → clarify → plan → tasks → implement`. Skipping phases is not permitted.

**Rationale**: The structured cycle surfaces ambiguity early, produces reviewable
artifacts, and prevents rework caused by under-specified requirements.

### XII. Code Review Before `/speckit-implement`

Before running `/speckit-implement`, the implementation plan MUST be reviewed by the
Code Reviewer agent from `agency-agents`. The review outcome MUST be documented.

**Rationale**: Pre-implementation review catches design issues before they become code,
which is cheaper to fix than post-implementation review.

### XIII. Security Review Before Merge to `main`

Every PR targeting `main` MUST pass `claude-code-security-review` before merge. The
review output MUST be attached to the PR.

**Rationale**: Automated security review provides a consistent, repeatable gate that
catches OWASP-class vulnerabilities before they reach production.

### XIV. Conventional Commits

All commits MUST follow Conventional Commits format using one of:
`feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Commit messages without a valid
type prefix MUST be rejected by the pre-commit hook.

**Rationale**: Enables automated changelogs, clear history browsing, and consistent
communication about the nature of each change.

### XV. One PR — One Feature

A PR MUST contain only the changes for a single feature. Refactoring and new feature
work MUST NOT be mixed in the same PR. Opportunistic cleanup belongs in a separate
`refactor:` PR.

**Rationale**: Small, focused PRs are faster to review, easier to revert, and produce
cleaner git history.

## UX/UI Principles

### XVI. Drag & Drop Uses Optimistic Updates with Rollback

All drag-and-drop interactions MUST apply changes optimistically in the UI immediately,
without waiting for the server response. On server error, the UI MUST roll back to the
previous state and surface the error to the user.

**Rationale**: Optimistic updates make drag-and-drop feel instant. Rollback on error
preserves data integrity and user trust.

### XVII. Human-Readable Errors — No Raw 500s

Every error that could reach the user MUST be presented in plain, human-readable
language via toast or inline message. Raw server error messages and HTTP 500 stack traces
MUST never be displayed to the user.

**Rationale**: Raw errors expose implementation details and are unusable for
non-technical users. Friendly errors maintain trust and guide users toward resolution.

### XVIII. Loading States Everywhere — Skeleton UI for Lists

Every operation that involves a network request MUST show a loading indicator. Lists and
data-heavy views MUST use Skeleton UI components while data is loading, not spinners
alone.

**Rationale**: Perceived performance is as important as actual performance. Skeleton UI
reduces layout shift and signals to users that content is coming.

## Performance

### XIX. No N+1 Queries

All database queries that require related data MUST use Prisma `include` or `select` to
fetch related records in a single query. Fetching related records in a loop is forbidden.

**Rationale**: N+1 queries degrade performance exponentially as data grows. Prisma's
`include`/`select` API makes this constraint easy to satisfy.

### XX. Pagination for Lists of 50+ Items

Any list view or API endpoint that may return 50 or more items MUST implement
cursor-based or offset pagination. Unbounded list queries are forbidden in production
code paths.

**Rationale**: Unbounded queries become a performance and memory hazard at scale.
Pagination keeps response times predictable and protects the database.

## Governance

This constitution is the highest-authority document for the CRM project. It supersedes
all other practices, patterns, and preferences. Compliance is non-negotiable.

**Amendment procedure**:
1. Open a PR with the proposed change to this file and a written rationale.
2. The PR MUST reference the principle(s) affected and justify the version bump type
   (MAJOR / MINOR / PATCH per semantic versioning rules defined in the spec-kit workflow).
3. The PR MUST pass security review (`claude-code-security-review`) before merge.
4. Update `LAST_AMENDED_DATE` and `CONSTITUTION_VERSION` in the version line below.

**Compliance review**: All PRs and plan reviews MUST verify adherence to the relevant
principles. Violations require a documented justification in the Complexity Tracking
section of `plan.md` before they may proceed.

**Versioning policy**:
- MAJOR: Removal or redefinition of a principle in a backward-incompatible way.
- MINOR: New principle or section added; materially expanded guidance.
- PATCH: Clarifications, wording fixes, non-semantic refinements.

**Version**: 1.0.0 | **Ratified**: 2026-05-05 | **Last Amended**: 2026-05-05
