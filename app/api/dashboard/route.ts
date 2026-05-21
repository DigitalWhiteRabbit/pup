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

    const wsIds = memberships.map((m) => m.workspace.id);

    // --- Batched queries: 3 queries instead of N*3+channel_count ---

    // 1) Open tickets per workspace (single groupBy)
    const ticketCounts = await db.ticket.groupBy({
      by: ["workspaceId"],
      where: {
        workspaceId: { in: wsIds },
        status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
      },
      _count: { id: true },
    });
    const ticketMap = new Map(
      ticketCounts.map((t) => [t.workspaceId, t._count.id]),
    );

    // 2) Active tasks per workspace (single groupBy via assignee join)
    const taskCounts = await db.taskAssignee.groupBy({
      by: ["taskId"],
      where: {
        userId,
        task: { workspaceId: { in: wsIds } },
      },
    });
    // Need workspace mapping — fetch tasks for the matched assignees
    const assignedTaskIds = taskCounts.map((t) => t.taskId);
    const assignedTasks =
      assignedTaskIds.length > 0
        ? await db.task.findMany({
            where: { id: { in: assignedTaskIds } },
            select: { id: true, workspaceId: true },
          })
        : [];
    const taskCountMap = new Map<string, number>();
    for (const t of assignedTasks) {
      taskCountMap.set(
        t.workspaceId,
        (taskCountMap.get(t.workspaceId) ?? 0) + 1,
      );
    }

    // 3) Unread chat: single fetch of all memberships + single groupBy for unread counts
    const allChatMembers = await db.chatChannelMember.findMany({
      where: {
        userId,
        channel: { workspaceId: { in: wsIds } },
      },
      select: {
        channelId: true,
        lastReadAt: true,
        channel: { select: { workspaceId: true } },
      },
    });

    // Build per-channel unread counts in ONE query using OR conditions
    let unreadResults: { channelId: string; _count: { id: number } }[] = [];
    if (allChatMembers.length > 0) {
      unreadResults = (await db.chatMsg.groupBy({
        by: ["channelId"],
        where: {
          deletedAt: null,
          authorId: { not: userId },
          OR: allChatMembers.map((cm) => ({
            channelId: cm.channelId,
            createdAt: { gt: cm.lastReadAt },
          })),
        },
        _count: { id: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as typeof unreadResults;
    }
    const unreadByChannel = new Map(
      unreadResults.map((r) => [r.channelId, r._count.id]),
    );

    // Aggregate unread by workspace
    const unreadByWs = new Map<string, number>();
    for (const cm of allChatMembers) {
      const wsId = cm.channel.workspaceId;
      const count = unreadByChannel.get(cm.channelId) ?? 0;
      unreadByWs.set(wsId, (unreadByWs.get(wsId) ?? 0) + count);
    }

    // Build workspace response from pre-computed maps (zero additional queries)
    const workspaces = memberships.map((m) => {
      const wsId = m.workspace.id;
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
        openTickets: ticketMap.get(wsId) ?? 0,
        unreadChat: unreadByWs.get(wsId) ?? 0,
        activeTasks: taskCountMap.get(wsId) ?? 0,
      };
    });

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

    // Map workspaceId → name (reuse memberships we already fetched)
    const wsNames = new Map<string, string>(
      memberships.map((m) => [m.workspace.id, m.workspace.name]),
    );
    // For tasks in workspaces not in memberships (edge case), fetch missing names
    const missingWsIds = myTasks
      .map((t) => t.workspaceId)
      .filter((id) => !wsNames.has(id));
    if (missingWsIds.length > 0) {
      const extraWs = await db.workspace.findMany({
        where: { id: { in: Array.from(new Set(missingWsIds)) } },
        select: { id: true, name: true },
      });
      for (const w of extraWs) wsNames.set(w.id, w.name);
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
