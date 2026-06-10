import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./membership-check";
import type { MemberRole } from "@prisma/client";

// Dynamic imports to avoid webpack chain through telegram/mailparser
async function getLogger() {
  const p = "./logger.service";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Function("p", "return import(p)")(p) as any;
}

// ─── Re-exports for backward compatibility ───────────────────────────────────
// Consumers can keep importing from workspace.service without changes.

export { checkMembership } from "./membership-check";
export type { MembershipRole } from "./membership-check";
// NOTE: addMember, removeMember, module access functions are in member.service.ts
// Do NOT re-export them here — it creates a webpack chain through telegram/mailparser
// Import directly from member.service.ts where needed (only in server-side code)
// NOTE: column functions are in column.service.ts
// Do NOT re-export — same webpack chain issue as member.service

// ─── Slug generation ─────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "ws"}-${suffix}`;
}

// ─── Module constants ─────────────────────────────────────────────────────────

const DEFAULT_MODULES = [
  "crm",
  "knowledge",
  "tickets",
  "logs",
  "chat",
  "marketing",
  "content",
  "analytics",
  "users",
] as const;

export type ModuleKey = (typeof DEFAULT_MODULES)[number];

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string | null;
  hasLogo: boolean;
  owner: { id: string; login: string };
  memberCount: number;
  createdAt: Date;
};

export type WorkspaceBoard = {
  id: string;
  name: string;
  description: string | null;
  logoPath: string | null;
  owner: { id: string; login: string };
  members: Array<{
    id: string;
    login: string;
    email: string;
    role: MemberRole;
    allowedModules: string[] | null;
  }>;
  columns: Array<{
    id: string;
    name: string;
    position: number;
    tasks: Array<{
      id: string;
      columnId: string;
      title: string;
      description: string | null;
      priority: string;
      position: number;
      startDate: Date | null;
      dueDate: Date | null;
      assignees: Array<{ id: string; login: string; isActive: boolean }>;
      labels: Array<{ id: string; name: string; color: string }>;
      checklistTotal: number;
      checklistDone: number;
      totalTimeMs: number;
      isInProgress: boolean;
      lastIntervalStartedAt: Date | null;
      createdAt: Date;
    }>;
  }>;
};

// ─── createWorkspace ──────────────────────────────────────────────────────────

export async function createWorkspace(input: {
  name: string;
  description?: string;
  ownerId: string;
}): Promise<{
  id: string;
  name: string;
  description: string | null;
  columns: Array<{ id: string; name: string; position: number }>;
}> {
  const result = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: input.name,
        slug: generateSlug(input.name),
        description: input.description ?? null,
        ownerId: input.ownerId,
      },
    });

    const columns = await Promise.all([
      tx.column.create({
        data: { workspaceId: workspace.id, name: "Ожидает", position: 0 },
      }),
      tx.column.create({
        data: { workspaceId: workspace.id, name: "В работе", position: 1 },
      }),
      tx.column.create({
        data: { workspaceId: workspace.id, name: "Готово", position: 2 },
      }),
    ]);

    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: input.ownerId, role: "OWNER" },
    });

    await tx.workspaceModule.createMany({
      data: DEFAULT_MODULES.map((moduleKey) => ({
        workspaceId: workspace.id,
        moduleKey,
        enabled: true,
      })),
    });

    return { workspace, columns };
  });

  await (
    await getLogger()
  ).logActivity({
    workspaceId: result.workspace.id,
    actorId: input.ownerId,
    action: "WORKSPACE_CREATED",
    entityType: "Workspace",
    entityId: result.workspace.id,
    summary: (await getLogger()).generateSummary("WORKSPACE_CREATED", {
      workspaceName: result.workspace.name,
    }),
    metadata: { workspaceName: result.workspace.name },
  });

  return {
    id: result.workspace.id,
    name: result.workspace.name,
    description: result.workspace.description,
    columns: result.columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
    })),
  };
}

// ─── getWorkspacesForUser ─────────────────────────────────────────────────────

export async function getWorkspacesForUser(
  userId: string,
  role: "ADMIN" | "USER",
  page: number,
  pageSize: number,
): Promise<{
  data: WorkspaceSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where = role === "ADMIN" ? {} : { members: { some: { userId } } };

  const [workspaces, total] = await db.$transaction([
    db.workspace.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        owner: { select: { id: true, login: true } },
        _count: { select: { members: true } },
      },
    }),
    db.workspace.count({ where }),
  ]);

  return {
    data: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      hasLogo: !!w.logoPath,
      owner: w.owner,
      memberCount: w._count.members,
      createdAt: w.createdAt,
    })),
    total,
    page,
    pageSize,
  };
}

// ─── getWorkspaceById ─────────────────────────────────────────────────────────

export async function getWorkspaceById(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<WorkspaceBoard> {
  const workspace = await db.workspace.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, login: true } },
      members: {
        orderBy: { joinedAt: "asc" },
        select: {
          role: true,
          userId: true,
          allowedModules: true,
          user: { select: { id: true, login: true, email: true } },
        },
      },
      columns: {
        orderBy: { position: "asc" },
        include: {
          tasks: {
            orderBy: { position: "asc" },
            take: 100,
            include: {
              assignees: {
                include: {
                  user: { select: { id: true, login: true, isActive: true } },
                },
              },
              labels: { include: { label: true } },
              checklistItems: { select: { checked: true } },
            },
          },
        },
      },
    },
  });

  if (!workspace) {
    throw new ApiError("Workspace не найден", "NOT_FOUND", 404);
  }

  if (userRole !== "ADMIN") {
    const isMember = workspace.members.some((m) => m.userId === userId);
    if (!isMember) {
      throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
    }
  }

  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    logoPath: workspace.logoPath,
    owner: workspace.owner,
    members: workspace.members.map((m) => {
      let parsedModules: string[] | null = null;
      if (m.allowedModules) {
        try {
          const parsed = JSON.parse(m.allowedModules) as unknown;
          if (Array.isArray(parsed)) parsedModules = parsed as string[];
        } catch {
          /* ignore malformed JSON */
        }
      }
      return {
        id: m.user.id,
        login: m.user.login,
        email: m.user.email,
        role: m.role,
        allowedModules: m.role === "OWNER" ? null : parsedModules,
      };
    }),
    columns: workspace.columns.map((col) => ({
      id: col.id,
      name: col.name,
      position: col.position,
      tasks: col.tasks.map((task) => {
        // timeIntervals excluded from board query for performance;
        // detailed time data loads on-demand when TaskModal opens
        const totalTimeMs = 0;
        const isInProgress = false;
        const lastIntervalStartedAt = null;
        return {
          id: task.id,
          columnId: col.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          position: task.position,
          startDate: task.startDate,
          dueDate: task.dueDate,
          assignees: task.assignees.map((a) => a.user),
          labels: task.labels.map((tl) => tl.label),
          checklistTotal: task.checklistItems.length,
          checklistDone: task.checklistItems.filter((i) => i.checked).length,
          totalTimeMs,
          isInProgress,
          lastIntervalStartedAt,
          createdAt: task.createdAt,
        };
      }),
    })),
  };
}

// ─── updateWorkspace ──────────────────────────────────────────────────────────

export async function updateWorkspace(
  id: string,
  data: { name?: string; description?: string | null },
  userId: string,
): Promise<{ id: string; name: string; description: string | null }> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может редактировать workspace",
      "FORBIDDEN",
      403,
    );
  }

  const updated = await db.workspace.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true },
  });

  await (
    await getLogger()
  ).logActivity({
    workspaceId: id,
    actorId: userId,
    action: "WORKSPACE_UPDATED",
    entityType: "Workspace",
    entityId: id,
    summary: (await getLogger()).generateSummary("WORKSPACE_UPDATED", {}),
    metadata: { changes: data },
  });

  return updated;
}

// ─── deleteWorkspace ──────────────────────────────────────────────────────────

export async function deleteWorkspace(
  id: string,
  userId: string,
): Promise<void> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может удалить workspace",
      "FORBIDDEN",
      403,
    );
  }

  const workspace = await db.workspace.findUnique({
    where: { id },
    select: {
      name: true,
      members: { select: { userId: true } },
    },
  });

  const workspaceName = workspace?.name ?? "?";
  const memberIds = workspace?.members.map((m) => m.userId) ?? [];

  // Stop marketing worker before deletion so it doesn't keep running against a deleted workspace
  try {
    const { stop: stopWorker } = await import("./marketing/mkt-worker.service");
    await stopWorker();
  } catch {
    // Worker may not be running or module may not be loaded — safe to ignore
  }

  await db.workspace.delete({ where: { id } });

  void (await getLogger()).notifyCriticalEvent({
    action: "WORKSPACE_DELETED",
    memberIds,
    workspaceName,
    actorLogin: userId,
  });
}

// ─── Module service ───────────────────────────────────────────────────────────

export async function getEnabledModules(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ModuleKey[]> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const modules = await db.workspaceModule.findMany({
    where: { workspaceId, enabled: true },
    select: { moduleKey: true },
  });

  return modules.map((m) => m.moduleKey as ModuleKey);
}

export async function getAllModules(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<Array<{ moduleKey: ModuleKey; enabled: boolean }>> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const modules = await db.workspaceModule.findMany({
    where: { workspaceId },
    select: { moduleKey: true, enabled: true },
  });

  return modules.map((m) => ({
    moduleKey: m.moduleKey as ModuleKey,
    enabled: m.enabled,
  }));
}

export async function setModuleEnabled(
  workspaceId: string,
  moduleKey: string,
  enabled: boolean,
  userId: string,
  _userRole: "ADMIN" | "USER",
): Promise<void> {
  const membership = await checkMembership(workspaceId, userId);
  // Only OWNER can toggle modules (not regular ADMIN)
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец workspace может управлять модулями",
      "FORBIDDEN",
      403,
    );
  }

  await db.workspaceModule.upsert({
    where: { workspaceId_moduleKey: { workspaceId, moduleKey } },
    update: { enabled },
    create: { workspaceId, moduleKey, enabled },
  });

  const actor = await db.user.findUnique({
    where: { id: userId },
    select: { login: true },
  });

  await (
    await getLogger()
  ).logActivity({
    workspaceId,
    actorId: userId,
    action: enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
    entityType: "WorkspaceModule",
    summary: (await getLogger()).generateSummary(
      enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
      {
        actorLogin: actor?.login,
        moduleName: moduleKey,
      },
    ),
    metadata: { moduleKey, enabled },
  });
}

export async function isModuleEnabled(
  workspaceId: string,
  moduleKey: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<boolean> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const mod = await db.workspaceModule.findUnique({
    where: { workspaceId_moduleKey: { workspaceId, moduleKey } },
    select: { enabled: true },
  });

  return mod?.enabled ?? false;
}
