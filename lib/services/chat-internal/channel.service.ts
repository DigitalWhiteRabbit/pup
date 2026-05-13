import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import type { ChatChannelType } from "@prisma/client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChannelView = {
  id: string;
  type: ChatChannelType;
  name: string | null;
  description: string | null;
  memberCount: number;
  lastMessage: {
    content: string;
    authorName: string;
    createdAt: Date;
  } | null;
  unreadCount: number;
};

export type ChannelDetail = ChannelView & {
  members: Array<{
    id: string;
    userId: string;
    login: string;
    lastReadAt: Date;
  }>;
};

// ─── Ensure General Channel ─────────────────────────────────────────────────

export async function ensureGeneralChannel(
  workspaceId: string,
): Promise<string> {
  const existing = await db.chatChannel.findFirst({
    where: { workspaceId, type: "GENERAL" },
    select: { id: true },
  });
  if (existing) return existing.id;

  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true },
  });

  const channel = await db.chatChannel.create({
    data: {
      workspaceId,
      type: "GENERAL",
      name: "Общий",
      description: "Канал для всех участников",
      members: {
        create: members.map((m) => ({ userId: m.userId })),
      },
    },
  });

  return channel.id;
}

// ─── Add member to General on workspace join ────────────────────────────────

export async function addUserToGeneralChannel(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const general = await db.chatChannel.findFirst({
    where: { workspaceId, type: "GENERAL" },
    select: { id: true },
  });
  if (!general) return;

  await db.chatChannelMember.upsert({
    where: { channelId_userId: { channelId: general.id, userId } },
    create: { channelId: general.id, userId },
    update: {},
  });
}

// ─── List channels ──────────────────────────────────────────────────────────

export async function listChannels(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ChannelView[]> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Ensure general exists
  await ensureGeneralChannel(workspaceId);

  const channels = await db.chatChannel.findMany({
    where: {
      workspaceId,
      OR: [
        { type: "GENERAL" },
        { type: "PUBLIC" },
        { members: { some: { userId } } },
      ],
    },
    include: {
      _count: { select: { members: true } },
      members: {
        where: { userId },
        select: { lastReadAt: true },
        take: 1,
      },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { author: { select: { login: true } } },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return channels.map((ch) => {
    const myMembership = ch.members[0];
    const lastMsg = ch.messages[0];
    const unreadCount = myMembership
      ? 0 // will be computed below
      : 0;

    return {
      id: ch.id,
      type: ch.type,
      name: ch.name,
      description: ch.description,
      memberCount: ch._count.members,
      lastMessage: lastMsg
        ? {
            content: lastMsg.content.slice(0, 100),
            authorName: lastMsg.author.login,
            createdAt: lastMsg.createdAt,
          }
        : null,
      unreadCount,
    };
  });
}

// ─── Create channel ─────────────────────────────────────────────────────────

export async function createChannel(
  workspaceId: string,
  input: {
    name: string;
    description?: string;
    type?: "PUBLIC" | "PRIVATE";
    memberIds?: string[];
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{ id: string }> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const type = input.type ?? "PUBLIC";
  const memberIds = new Set(input.memberIds ?? []);
  memberIds.add(userId); // creator always in

  const channel = await db.chatChannel.create({
    data: {
      workspaceId,
      type,
      name: input.name,
      description: input.description ?? null,
      members: {
        create: Array.from(memberIds).map((uid) => ({ userId: uid })),
      },
    },
  });

  return { id: channel.id };
}

// ─── Create or get DM ───────────────────────────────────────────────────────

export async function getOrCreateDM(
  workspaceId: string,
  userId: string,
  targetUserId: string,
  userRole: "ADMIN" | "USER",
): Promise<{ id: string }> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Find existing DM between these two users
  const existing = await db.chatChannel.findFirst({
    where: {
      workspaceId,
      type: "DM",
      AND: [
        { members: { some: { userId } } },
        { members: { some: { userId: targetUserId } } },
      ],
    },
    select: { id: true },
  });

  if (existing) return { id: existing.id };

  const channel = await db.chatChannel.create({
    data: {
      workspaceId,
      type: "DM",
      members: {
        create: [{ userId }, { userId: targetUserId }],
      },
    },
  });

  return { id: channel.id };
}

// ─── Get channel detail ─────────────────────────────────────────────────────

export async function getChannelDetail(
  channelId: string,
  userId: string,
): Promise<ChannelDetail> {
  const channel = await db.chatChannel.findUnique({
    where: { id: channelId },
    include: {
      _count: { select: { members: true } },
      members: {
        include: { user: { select: { id: true, login: true } } },
      },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { author: { select: { login: true } } },
      },
    },
  });

  if (!channel) throw new ApiError("Канал не найден", "NOT_FOUND", 404);

  // Check access
  const isMember = channel.members.some((m) => m.userId === userId);
  if (!isMember && channel.type !== "PUBLIC" && channel.type !== "GENERAL") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const lastMsg = channel.messages[0];

  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    description: channel.description,
    memberCount: channel._count.members,
    lastMessage: lastMsg
      ? {
          content: lastMsg.content.slice(0, 100),
          authorName: lastMsg.author.login,
          createdAt: lastMsg.createdAt,
        }
      : null,
    unreadCount: 0,
    members: channel.members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      login: m.user.login,
      lastReadAt: m.lastReadAt,
    })),
  };
}
