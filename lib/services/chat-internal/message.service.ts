import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { sendTelegramNotification } from "../telegram/sender";
import { broadcastToChannelMembers } from "./sse.service";
import {
  assertChannelAccess,
  assertMessageChannelAccess,
  resolveChannelDelivery,
} from "./channel-access";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChatAttachmentView = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
};

export type ForwardInfo = {
  originalAuthorLogin: string;
  originalChannelName: string | null;
};

export type ChatMsgView = {
  id: string;
  authorId: string;
  authorLogin: string;
  content: string;
  parentId: string | null;
  linkedTicketId: string | null;
  linkedTaskId: string | null;
  editedAt: Date | null;
  createdAt: Date;
  replyCount: number;
  replyTo: { authorLogin: string; content: string } | null;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
  attachments: ChatAttachmentView[];
  forwardedFrom: ForwardInfo | null;
  readByCount: number;
  pinnedAt: Date | null;
};

// ─── List messages ──────────────────────────────────────────────────────────

export async function listMessages(
  channelId: string,
  userId: string,
  workspaceId: string,
  opts: { limit?: number; before?: string; role?: string } = {},
): Promise<ChatMsgView[]> {
  // Channel-level access (workspace-scoped; PRIVATE/DM require membership).
  await assertChannelAccess(channelId, workspaceId, userId, opts.role);

  const limit = opts.limit ?? 50;
  const where: Record<string, unknown> = {
    channelId,
    deletedAt: null,
  };
  if (opts.before) {
    const beforeMsg = await db.chatMsg.findUnique({
      where: { id: opts.before },
      select: { createdAt: true },
    });
    if (beforeMsg) {
      where.createdAt = { lt: beforeMsg.createdAt };
    }
  }

  // Fetch all member lastReadAt for read receipt computation
  const members = await db.chatChannelMember.findMany({
    where: { channelId },
    select: { userId: true, lastReadAt: true },
  });

  const messages = await db.chatMsg.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      author: { select: { id: true, login: true } },
      parent: {
        select: { content: true, author: { select: { login: true } } },
      },
      _count: { select: { replies: true } },
      reactions: { select: { emoji: true, userId: true } },
      attachments: {
        select: { id: true, originalName: true, size: true, mimeType: true },
      },
      forwardedFrom: {
        select: {
          author: { select: { login: true } },
          channel: { select: { name: true } },
        },
      },
    },
  });

  return messages.reverse().map((m) => {
    const reactionMap = new Map<
      string,
      { count: number; myReaction: boolean }
    >();
    for (const r of m.reactions) {
      const existing = reactionMap.get(r.emoji);
      if (existing) {
        existing.count++;
        if (r.userId === userId) existing.myReaction = true;
      } else {
        reactionMap.set(r.emoji, { count: 1, myReaction: r.userId === userId });
      }
    }

    // Compute read receipts: count members (excluding author) whose lastReadAt >= msg.createdAt
    const readByCount = members.filter(
      (mem) => mem.userId !== m.authorId && mem.lastReadAt >= m.createdAt,
    ).length;

    return {
      id: m.id,
      authorId: m.author.id,
      authorLogin: m.author.login,
      content: m.content,
      parentId: m.parentId,
      linkedTicketId: m.linkedTicketId,
      linkedTaskId: m.linkedTaskId,
      editedAt: m.editedAt,
      createdAt: m.createdAt,
      replyCount: m._count.replies,
      replyTo: (
        m as unknown as {
          parent?: { content: string; author: { login: string } };
        }
      ).parent
        ? {
            authorLogin: (
              m as unknown as { parent: { author: { login: string } } }
            ).parent.author.login,
            content: (
              m as unknown as { parent: { content: string } }
            ).parent.content.slice(0, 100),
          }
        : null,
      reactions: Array.from(reactionMap.entries()).map(([emoji, data]) => ({
        emoji,
        ...data,
      })),
      attachments: m.attachments ?? [],
      forwardedFrom: m.forwardedFrom
        ? {
            originalAuthorLogin: m.forwardedFrom.author.login,
            originalChannelName: m.forwardedFrom.channel.name,
          }
        : null,
      readByCount,
      pinnedAt: m.pinnedAt,
    };
  });
}

// ─── Get thread replies ─────────────────────────────────────────────────────

export async function getThreadReplies(
  messageId: string,
  userId: string,
  workspaceId: string,
  role?: string,
): Promise<ChatMsgView[]> {
  // Channel/workspace scope + access.
  await assertMessageChannelAccess(messageId, workspaceId, userId, role);

  const replies = await db.chatMsg.findMany({
    where: { parentId: messageId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: { id: true, login: true } },
      _count: { select: { replies: true } },
      reactions: { select: { emoji: true, userId: true } },
      attachments: {
        select: { id: true, originalName: true, size: true, mimeType: true },
      },
      forwardedFrom: {
        select: {
          author: { select: { login: true } },
          channel: { select: { name: true } },
        },
      },
    },
  });

  return replies.map((m) => {
    const reactionMap = new Map<
      string,
      { count: number; myReaction: boolean }
    >();
    for (const r of m.reactions) {
      const existing = reactionMap.get(r.emoji);
      if (existing) {
        existing.count++;
        if (r.userId === userId) existing.myReaction = true;
      } else {
        reactionMap.set(r.emoji, { count: 1, myReaction: r.userId === userId });
      }
    }
    return {
      id: m.id,
      authorId: m.author.id,
      authorLogin: m.author.login,
      content: m.content,
      parentId: m.parentId,
      linkedTicketId: m.linkedTicketId,
      linkedTaskId: m.linkedTaskId,
      editedAt: m.editedAt,
      createdAt: m.createdAt,
      replyCount: m._count.replies,
      replyTo: null,
      reactions: Array.from(reactionMap.entries()).map(([emoji, data]) => ({
        emoji,
        ...data,
      })),
      attachments: m.attachments ?? [],
      forwardedFrom: m.forwardedFrom
        ? {
            originalAuthorLogin: m.forwardedFrom.author.login,
            originalChannelName: m.forwardedFrom.channel.name,
          }
        : null,
      readByCount: 0,
      pinnedAt: null,
    };
  });
}

// ─── Send message ───────────────────────────────────────────────────────────

export async function sendMessage(
  channelId: string,
  userId: string,
  workspaceId: string,
  input: {
    content: string;
    parentId?: string;
    linkedTicketId?: string;
    linkedTaskId?: string;
    forwardedFromId?: string;
  },
  role?: string,
): Promise<ChatMsgView> {
  // Channel-level access: channel must be in this workspace; PRIVATE/DM require
  // membership; PUBLIC/GENERAL require workspace membership. No silent auto-join
  // into arbitrary channels — access is decided here.
  const channel = await assertChannelAccess(
    channelId,
    workspaceId,
    userId,
    role,
  );

  // Bookkeeping: ensure a membership row exists on open channels so read-receipt
  // tracking works (access is already granted above).
  if (channel.type === "PUBLIC" || channel.type === "GENERAL") {
    await db.chatChannelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
  }

  const msg = await db.chatMsg.create({
    data: {
      channelId,
      authorId: userId,
      content: input.content,
      parentId: input.parentId ?? null,
      linkedTicketId: input.linkedTicketId ?? null,
      linkedTaskId: input.linkedTaskId ?? null,
      forwardedFromId: input.forwardedFromId ?? null,
    },
    include: {
      author: { select: { id: true, login: true } },
      _count: { select: { replies: true } },
    },
  });

  // Update channel timestamp
  await db.chatChannel.update({
    where: { id: channelId },
    data: { updatedAt: new Date() },
  });

  // Update sender's lastReadAt (updateMany → no-op if no membership row, e.g.
  // an ADMIN posting to a private channel they're not a member of).
  await db.chatChannelMember.updateMany({
    where: { channelId, userId },
    data: { lastReadAt: new Date() },
  });

  // @mentions → Telegram notifications
  void notifyMentions(channelId, userId, msg.author.login, input.content);

  const result: ChatMsgView = {
    id: msg.id,
    authorId: msg.author.id,
    authorLogin: msg.author.login,
    content: msg.content,
    parentId: msg.parentId,
    linkedTicketId: msg.linkedTicketId,
    linkedTaskId: msg.linkedTaskId,
    editedAt: null,
    createdAt: msg.createdAt,
    replyCount: msg._count.replies,
    replyTo: null,
    reactions: [],
    attachments: [],
    forwardedFrom: null,
    readByCount: 0,
    pinnedAt: null,
  };

  // SSE broadcast — fire and forget
  void sseNotifyNewMessage(channelId, result);

  return result;
}

// ─── Edit message ───────────────────────────────────────────────────────────

export async function editMessage(
  messageId: string,
  userId: string,
  workspaceId: string,
  content: string,
  role?: string,
): Promise<void> {
  // Channel/workspace scope + access (also 404s a cross-ws messageId).
  const msg = await assertMessageChannelAccess(
    messageId,
    workspaceId,
    userId,
    role,
  );
  // Edit is author-only (even ADMIN cannot rewrite another user's message).
  if (msg.authorId !== userId)
    throw new ApiError(
      "Можно редактировать только свои сообщения",
      "FORBIDDEN",
      403,
    );

  const updated = await db.chatMsg.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
  });

  // SSE broadcast
  void sseNotifyMessageEdited(msg.channelId, {
    messageId,
    channelId: msg.channelId,
    content,
    editedAt: updated.editedAt!.toISOString(),
  });
}

// ─── Delete message (soft) ──────────────────────────────────────────────────

export async function deleteMessage(
  messageId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  workspaceId: string,
): Promise<void> {
  // Channel/workspace scope + access (also 404s a cross-ws messageId).
  const msg = await assertMessageChannelAccess(
    messageId,
    workspaceId,
    userId,
    userRole,
  );
  // Author OR global ADMIN (parity; unified ADMIN policy → P0 #3).
  if (msg.authorId !== userId && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.chatMsg.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });

  // SSE broadcast
  void sseNotifyMessageDeleted(msg.channelId, messageId);
}

// ─── Toggle reaction ────────────────────────────────────────────────────────

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
  workspaceId: string,
  role?: string,
): Promise<{ added: boolean }> {
  // Channel/workspace scope + access (kills cross-channel/cross-ws reaction IDOR).
  const msg = await assertMessageChannelAccess(
    messageId,
    workspaceId,
    userId,
    role,
  );

  const existing = await db.chatMsgReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });

  if (existing) {
    await db.chatMsgReaction.delete({ where: { id: existing.id } });
    // SSE broadcast
    if (msg) {
      void sseNotifyReaction(msg.channelId, {
        messageId,
        channelId: msg.channelId,
        emoji,
        added: false,
        userId,
      });
    }
    return { added: false };
  }

  await db.chatMsgReaction.create({
    data: { messageId, userId, emoji },
  });

  // SSE broadcast
  if (msg) {
    void sseNotifyReaction(msg.channelId, {
      messageId,
      channelId: msg.channelId,
      emoji,
      added: true,
      userId,
    });
  }

  return { added: true };
}

// ─── Mark read ──────────────────────────────────────────────────────────────

export async function markChannelRead(
  channelId: string,
  userId: string,
  workspaceId: string,
  role?: string,
): Promise<void> {
  await assertChannelAccess(channelId, workspaceId, userId, role);
  await db.chatChannelMember.updateMany({
    where: { channelId, userId },
    data: { lastReadAt: new Date() },
  });
}

// ─── @mentions → Telegram ───────────────────────────────────────────────────

async function notifyMentions(
  channelId: string,
  senderId: string,
  senderLogin: string,
  content: string,
): Promise<void> {
  try {
    // Parse @mentions
    const mentionRegex = /@(\w+)/g;
    const mentions = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(content)) !== null) {
      if (match[1]) mentions.add(match[1]);
    }

    if (mentions.size === 0) return;

    const channel = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { name: true, type: true },
    });
    const channelName = channel?.name ?? "Личные сообщения";

    // Check @all
    if (mentions.has("all")) {
      const members = await db.chatChannelMember.findMany({
        where: { channelId, userId: { not: senderId }, muted: false },
        include: {
          user: {
            select: { telegramChatId: true, tgNotifyChat: true },
          },
        },
      });
      for (const m of members) {
        if (m.user.telegramChatId && m.user.tgNotifyChat) {
          const short =
            content.length > 100 ? content.slice(0, 100) + "..." : content;
          const msg = `<b>💬 @all в "${channelName}"</b>\n${senderLogin}: ${short}`;
          void sendTelegramNotification(m.user.telegramChatId, msg);
        }
      }
      return;
    }

    // Individual mentions — batch-load all users + membership in two queries
    const mentionLogins = Array.from(mentions);
    const mentionedUsers = await db.user.findMany({
      where: { login: { in: mentionLogins } },
      select: {
        id: true,
        login: true,
        telegramChatId: true,
        tgNotifyChat: true,
      },
    });

    // Filter out sender
    const eligibleUsers = mentionedUsers.filter((u) => u.id !== senderId);
    if (eligibleUsers.length === 0) return;

    // Batch-load mute status for all eligible users in this channel
    const memberRecords = await db.chatChannelMember.findMany({
      where: {
        channelId,
        userId: { in: eligibleUsers.map((u) => u.id) },
      },
      select: { userId: true, muted: true },
    });
    const mutedSet = new Set(
      memberRecords.filter((m) => m.muted).map((m) => m.userId),
    );

    for (const user of eligibleUsers) {
      if (mutedSet.has(user.id)) continue;

      if (user.telegramChatId && user.tgNotifyChat) {
        const short =
          content.length > 100 ? content.slice(0, 100) + "..." : content;
        const msg = `<b>💬 Вас упомянули в "${channelName}"</b>\n${senderLogin}: ${short}`;
        void sendTelegramNotification(user.telegramChatId, msg);
      }
    }
  } catch {
    /* fire-and-forget */
  }
}

// ─── SSE broadcast helpers ─────────────────────────────────────────────────
// These resolve the workspaceId from the channel and broadcast the event.
// All are fire-and-forget — errors are swallowed to avoid impacting the
// primary write path.

// Deliver a message-level SSE event scoped to the channel: PUBLIC/GENERAL →
// all workspace clients; PRIVATE/DM → channel members only (no leak to
// non-member workspace clients).
async function sseDeliver(
  channelId: string,
  type:
    | "new_message"
    | "message_edited"
    | "message_deleted"
    | "reaction_toggled",
  data: unknown,
): Promise<void> {
  try {
    const d = await resolveChannelDelivery(channelId);
    if (!d) return;
    broadcastToChannelMembers(d.workspaceId, d.recipients, { type, data });
  } catch {
    /* fire-and-forget */
  }
}

async function sseNotifyNewMessage(
  channelId: string,
  message: ChatMsgView,
): Promise<void> {
  await sseDeliver(channelId, "new_message", { channelId, message });
}

async function sseNotifyMessageEdited(
  channelId: string,
  payload: {
    messageId: string;
    channelId: string;
    content: string;
    editedAt: string;
  },
): Promise<void> {
  await sseDeliver(channelId, "message_edited", payload);
}

async function sseNotifyMessageDeleted(
  channelId: string,
  messageId: string,
): Promise<void> {
  await sseDeliver(channelId, "message_deleted", { channelId, messageId });
}

async function sseNotifyReaction(
  channelId: string,
  payload: {
    messageId: string;
    channelId: string;
    emoji: string;
    added: boolean;
    userId: string;
  },
): Promise<void> {
  await sseDeliver(channelId, "reaction_toggled", payload);
}
