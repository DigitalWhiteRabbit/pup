import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { getActivePersona } from "./persona-rotation.service";
import { logActivity, generateSummary } from "../logger.service";
import type { CustomerIdentityMethod } from "@prisma/client";

// ─── Public config (no auth) ────────────────────────────────────────────────

export type PublicChatConfig = {
  workspaceName: string;
  chatTitle: string;
  chatSubtitle: string;
  chatAccentColor: string;
  chatLogoUrl: string | null;
  identityMethod: CustomerIdentityMethod;
  activePersona: {
    displayName: string;
    role: string;
    bio: string | null;
    avatarUrl: string | null;
  } | null;
  allPersonas: Array<{
    displayName: string;
    role: string;
    bio: string | null;
    avatarUrl: string | null;
  }> | null;
};

export async function getPublicChatConfig(
  workspaceSlug: string,
): Promise<PublicChatConfig> {
  const workspace = await db.workspace.findUnique({
    where: { slug: workspaceSlug },
    include: {
      modules: {
        where: { moduleKey: "tickets" },
        select: { enabled: true },
      },
    },
  });

  if (!workspace) {
    throw new ApiError("Не найдено", "NOT_FOUND", 404);
  }

  const ticketsModule = workspace.modules[0];
  if (!ticketsModule?.enabled) {
    throw new ApiError("Не найдено", "NOT_FOUND", 404);
  }

  const persona = await getActivePersona(workspace.id);

  let allPersonas: PublicChatConfig["allPersonas"] = null;
  if (!workspace.chatPersonaRotation) {
    const personas = await db.chatPersona.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { position: "asc" },
      select: { displayName: true, role: true, bio: true, avatarUrl: true },
    });
    allPersonas = personas.length > 0 ? personas : null;
  }

  return {
    workspaceName: workspace.name,
    chatTitle: workspace.chatTitle || `Поддержка ${workspace.name}`,
    chatSubtitle: workspace.chatSubtitle || "Мы отвечаем быстро",
    chatAccentColor: workspace.chatAccentColor || "#22c55e",
    chatLogoUrl: workspace.chatLogoUrl,
    identityMethod: workspace.chatIdentityMethod,
    activePersona: persona
      ? {
          displayName: persona.displayName,
          role: persona.role,
          bio: persona.bio,
          avatarUrl: persona.avatarUrl,
        }
      : null,
    allPersonas,
  };
}

// ─── Settings (authenticated, OWNER only) ───────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function updateChatSettings(
  workspaceId: string,
  data: {
    chatTitle?: string | null;
    chatSubtitle?: string | null;
    chatAccentColor?: string | null;
    chatLogoUrl?: string | null;
    chatIdentityMethod?: CustomerIdentityMethod;
    chatPersonaRotation?: boolean;
    chatAllowedEmbedOrigins?: string | null;
    chatTimezone?: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const membership = await checkMembership(workspaceId, userId);
  if (membership !== "OWNER" && userRole !== "ADMIN") {
    throw new ApiError(
      "Только владелец может менять настройки чата",
      "FORBIDDEN",
      403,
    );
  }

  if (data.chatAccentColor && !HEX_COLOR_RE.test(data.chatAccentColor)) {
    throw new ApiError(
      "Неверный формат цвета (ожидается #RRGGBB)",
      "INVALID_COLOR",
      400,
    );
  }

  if (
    data.chatAllowedEmbedOrigins !== undefined &&
    data.chatAllowedEmbedOrigins !== null
  ) {
    try {
      const parsed: unknown = JSON.parse(data.chatAllowedEmbedOrigins);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((v) => typeof v === "string")
      ) {
        throw new Error();
      }
    } catch {
      throw new ApiError(
        "chatAllowedEmbedOrigins должен быть JSON-массивом строк",
        "INVALID_ORIGINS",
        400,
      );
    }
  }

  await db.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(data.chatTitle !== undefined ? { chatTitle: data.chatTitle } : {}),
      ...(data.chatSubtitle !== undefined
        ? { chatSubtitle: data.chatSubtitle }
        : {}),
      ...(data.chatAccentColor !== undefined
        ? { chatAccentColor: data.chatAccentColor }
        : {}),
      ...(data.chatLogoUrl !== undefined
        ? { chatLogoUrl: data.chatLogoUrl }
        : {}),
      ...(data.chatIdentityMethod !== undefined
        ? { chatIdentityMethod: data.chatIdentityMethod }
        : {}),
      ...(data.chatPersonaRotation !== undefined
        ? { chatPersonaRotation: data.chatPersonaRotation }
        : {}),
      ...(data.chatAllowedEmbedOrigins !== undefined
        ? { chatAllowedEmbedOrigins: data.chatAllowedEmbedOrigins }
        : {}),
      ...(data.chatTimezone !== undefined
        ? { chatTimezone: data.chatTimezone }
        : {}),
    },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "CHAT_SETTINGS_UPDATED",
    entityType: "Workspace",
    entityId: workspaceId,
    summary: generateSummary("CHAT_SETTINGS_UPDATED", {
      actorLogin: undefined,
    }),
    metadata: data as Record<string, unknown>,
  });
}

// ─── ChatPersona CRUD ───────────────────────────────────────────────────────

export async function createPersona(
  workspaceId: string,
  input: {
    displayName: string;
    role: string;
    bio?: string;
    avatarUrl?: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
) {
  const membership = await checkMembership(workspaceId, userId);
  if (membership !== "OWNER" && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const maxPos = await db.chatPersona.findFirst({
    where: { workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const persona = await db.chatPersona.create({
    data: {
      workspaceId,
      displayName: input.displayName,
      role: input.role,
      bio: input.bio ?? null,
      avatarUrl: input.avatarUrl ?? null,
      position: (maxPos?.position ?? -1) + 1,
    },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "CHAT_PERSONA_CREATED",
    entityType: "ChatPersona",
    entityId: persona.id,
    summary: generateSummary("CHAT_PERSONA_CREATED", {
      kbArticleTitle: persona.displayName,
    }),
    metadata: { displayName: persona.displayName },
  });

  return persona;
}

export async function updatePersona(
  personaId: string,
  data: {
    displayName?: string;
    role?: string;
    bio?: string | null;
    avatarUrl?: string | null;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
) {
  const persona = await db.chatPersona.findUnique({
    where: { id: personaId },
    select: { workspaceId: true },
  });
  if (!persona) throw new ApiError("Персона не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(persona.workspaceId, userId);
  if (membership !== "OWNER" && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const updated = await db.chatPersona.update({
    where: { id: personaId },
    data: {
      ...(data.displayName !== undefined
        ? { displayName: data.displayName }
        : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.bio !== undefined ? { bio: data.bio } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
    },
  });

  void logActivity({
    workspaceId: persona.workspaceId,
    actorId: userId,
    action: "CHAT_PERSONA_UPDATED",
    entityType: "ChatPersona",
    entityId: personaId,
    summary: generateSummary("CHAT_PERSONA_UPDATED", {
      kbArticleTitle: updated.displayName,
    }),
    metadata: data as Record<string, unknown>,
  });

  return updated;
}

export async function deletePersona(
  personaId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
) {
  const persona = await db.chatPersona.findUnique({
    where: { id: personaId },
    select: { workspaceId: true, displayName: true },
  });
  if (!persona) throw new ApiError("Персона не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(persona.workspaceId, userId);
  if (membership !== "OWNER" && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.chatPersona.delete({ where: { id: personaId } });

  void logActivity({
    workspaceId: persona.workspaceId,
    actorId: userId,
    action: "CHAT_PERSONA_DELETED",
    entityType: "ChatPersona",
    entityId: personaId,
    summary: generateSummary("CHAT_PERSONA_DELETED", {
      kbArticleTitle: persona.displayName,
    }),
    metadata: {},
  });
}

export async function listPersonas(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
) {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  return db.chatPersona.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
  });
}

export async function reorderPersonas(
  workspaceId: string,
  personaIds: string[],
  userId: string,
  userRole: "ADMIN" | "USER",
) {
  const membership = await checkMembership(workspaceId, userId);
  if (membership !== "OWNER" && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  // Verify all personas belong to this workspace
  const existing = await db.chatPersona.findMany({
    where: { workspaceId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((p) => p.id));
  for (const id of personaIds) {
    if (!existingIds.has(id)) {
      throw new ApiError(
        "Персона не принадлежит этому workspace",
        "INVALID_PERSONA",
        400,
      );
    }
  }

  await db.$transaction(
    personaIds.map((id, idx) =>
      db.chatPersona.update({ where: { id }, data: { position: idx } }),
    ),
  );
}
