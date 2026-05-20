import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const userId = session.user.id;

    // Get workspaces user is member of
    const memberships = await db.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          select: { id: true, name: true, ownerId: true, logoPath: true },
        },
      },
    });

    const workspaces = await Promise.all(
      memberships.map(async (m) => {
        const wsId = m.workspace.id;

        // Open tickets count
        const openTickets = await db.ticket.count({
          where: {
            workspaceId: wsId,
            status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
          },
        });

        // Unread chat messages
        const chatMembers = await db.chatChannelMember.findMany({
          where: { userId, channel: { workspaceId: wsId } },
          select: { channelId: true, lastReadAt: true },
        });
        let unreadChat = 0;
        for (const cm of chatMembers) {
          unreadChat += await db.chatMsg.count({
            where: {
              channelId: cm.channelId,
              deletedAt: null,
              createdAt: { gt: cm.lastReadAt },
              authorId: { not: userId },
            },
          });
        }

        // Active tasks assigned to user
        const activeTasks = await db.task.count({
          where: {
            workspaceId: wsId,
            assignees: { some: { userId } },
          },
        });

        return {
          id: wsId,
          name: m.workspace.name,
          hasLogo: !!m.workspace.logoPath,
          role:
            m.workspace.ownerId === userId
              ? "Владелец"
              : m.role === "OWNER"
                ? "Админ"
                : "Участник",
          openTickets,
          unreadChat,
          activeTasks,
        };
      }),
    );

    // My tasks across all workspaces (top 10)
    const myTasks = await db.task.findMany({
      where: {
        assignees: { some: { userId } },
        column: {
          name: {
            notIn: ["Готово", "Done", "Завершено", "Готовые", "Выполнено"],
          },
        },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true,
        title: true,
        priority: true,
        workspaceId: true,
      },
    });

    // Map workspaceId → name
    const wsIds = Array.from(new Set(myTasks.map((t) => t.workspaceId)));
    const wsNames = new Map<string, string>();
    if (wsIds.length > 0) {
      const wsList = await db.workspace.findMany({
        where: { id: { in: wsIds } },
        select: { id: true, name: true },
      });
      for (const w of wsList) wsNames.set(w.id, w.name);
    }

    // Recent activity logs (last 10)
    const recentLogs = await db.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      where: {
        workspace: {
          members: { some: { userId } },
        },
      },
      include: {
        actor: { select: { login: true } },
        workspace: { select: { name: true } },
      },
    });

    // Global chat last messages
    const globalChatMsgs = await db.globalChatMsg.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        author: { select: { id: true, login: true, avatarPath: true } },
        attachments: { select: { id: true, mimeType: true } },
      },
    });

    // Global chat unread
    const myLastGlobalMsg = await db.globalChatMsg.findFirst({
      where: { authorId: userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const globalUnread = await db.globalChatMsg.count({
      where: {
        deletedAt: null,
        authorId: { not: userId },
        ...(myLastGlobalMsg
          ? { createdAt: { gt: myLastGlobalMsg.createdAt } }
          : {}),
      },
    });

    return NextResponse.json({
      workspaces,
      myTasks: myTasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        workspaceId: t.workspaceId,
        workspaceName: wsNames.get(t.workspaceId) ?? "",
      })),
      recentLogs: recentLogs.map((l) => ({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        summary: l.summary,
        createdAt: l.createdAt,
        userLogin: l.actor?.login ?? "система",
        workspaceName: l.workspace?.name ?? "",
      })),
      globalChat: {
        unread: globalUnread,
        lastMessages: globalChatMsgs.reverse().map((m) => ({
          id: m.id,
          authorId: m.author.id,
          authorLogin: m.author.login,
          authorHasAvatar: !!m.author.avatarPath,
          content: m.content.slice(0, 150),
          fullLength: m.content.length,
          createdAt: m.createdAt,
          audioAttachmentId:
            m.attachments.find((a) => a.mimeType.startsWith("audio/"))?.id ??
            null,
        })),
      },
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
