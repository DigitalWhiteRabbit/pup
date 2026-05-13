import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { sendTelegramNotification } from "../telegram/sender";

// ─── Types ──────────────────────────────────────────────────────────────────

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
};

// ─── List messages ──────────────────────────────────────────────────────────

export async function listMessages(
  channelId: string,
  userId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatMsgView[]> {
  // Verify membership
  const membership = await db.chatChannelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
  });
  if (!membership) {
    // Check if public/general
    const ch = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    if (!ch || (ch.type !== "PUBLIC" && ch.type !== "GENERAL")) {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }
  }

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
    };
  });
}

// ─── Get thread replies ─────────────────────────────────────────────────────

export async function getThreadReplies(
  messageId: string,
  userId: string,
): Promise<ChatMsgView[]> {
  const parent = await db.chatMsg.findUnique({
    where: { id: messageId },
    select: { channelId: true },
  });
  if (!parent) throw new ApiError("Сообщение не найдено", "NOT_FOUND", 404);

  const replies = await db.chatMsg.findMany({
    where: { parentId: messageId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: { id: true, login: true } },
      _count: { select: { replies: true } },
      reactions: { select: { emoji: true, userId: true } },
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
    };
  });
}

// ─── Send message ───────────────────────────────────────────────────────────

export async function sendMessage(
  channelId: string,
  userId: string,
  input: {
    content: string;
    parentId?: string;
    linkedTicketId?: string;
    linkedTaskId?: string;
  },
): Promise<ChatMsgView> {
  // Verify membership (auto-join for public/general)
  let membership = await db.chatChannelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
  });
  if (!membership) {
    const ch = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    if (ch && (ch.type === "PUBLIC" || ch.type === "GENERAL")) {
      membership = await db.chatChannelMember.create({
        data: { channelId, userId },
      });
    } else {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }
  }

  const msg = await db.chatMsg.create({
    data: {
      channelId,
      authorId: userId,
      content: input.content,
      parentId: input.parentId ?? null,
      linkedTicketId: input.linkedTicketId ?? null,
      linkedTaskId: input.linkedTaskId ?? null,
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

  // Update sender's lastReadAt
  await db.chatChannelMember.update({
    where: { channelId_userId: { channelId, userId } },
    data: { lastReadAt: new Date() },
  });

  // @mentions → Telegram notifications
  void notifyMentions(channelId, userId, msg.author.login, input.content);

  return {
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
  };
}

// ─── Edit message ───────────────────────────────────────────────────────────

export async function editMessage(
  messageId: string,
  userId: string,
  content: string,
): Promise<void> {
  const msg = await db.chatMsg.findUnique({
    where: { id: messageId },
    select: { authorId: true },
  });
  if (!msg) throw new ApiError("Не найдено", "NOT_FOUND", 404);
  if (msg.authorId !== userId)
    throw new ApiError(
      "Можно редактировать только свои сообщения",
      "FORBIDDEN",
      403,
    );

  await db.chatMsg.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
  });
}

// ─── Delete message (soft) ──────────────────────────────────────────────────

export async function deleteMessage(
  messageId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const msg = await db.chatMsg.findUnique({
    where: { id: messageId },
    select: { authorId: true },
  });
  if (!msg) throw new ApiError("Не найдено", "NOT_FOUND", 404);
  if (msg.authorId !== userId && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.chatMsg.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });
}

// ─── Toggle reaction ────────────────────────────────────────────────────────

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  const existing = await db.chatMsgReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });

  if (existing) {
    await db.chatMsgReaction.delete({ where: { id: existing.id } });
    return { added: false };
  }

  await db.chatMsgReaction.create({
    data: { messageId, userId, emoji },
  });
  return { added: true };
}

// ─── Mark read ──────────────────────────────────────────────────────────────

export async function markChannelRead(
  channelId: string,
  userId: string,
): Promise<void> {
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
        where: { channelId, userId: { not: senderId } },
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

    // Individual mentions
    for (const login of Array.from(mentions)) {
      const user = await db.user.findFirst({
        where: { login },
        select: { id: true, telegramChatId: true, tgNotifyChat: true },
      });
      if (
        user &&
        user.id !== senderId &&
        user.telegramChatId &&
        user.tgNotifyChat
      ) {
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
