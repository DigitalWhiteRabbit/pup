import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/notifications/chat-updates?since=ISO_DATE
 * Returns new messages across all chats (workspace + global) since the given timestamp.
 * Used by the notification toast system.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = req.nextUrl.searchParams.get("since");
  if (!since) return NextResponse.json({ messages: [] });

  const sinceDate = new Date(since);
  const userId = session.user.id;

  // Workspace chat messages (channels user is a member of)
  const memberships = await db.chatChannelMember.findMany({
    where: { userId },
    select: {
      channelId: true,
      channel: {
        select: {
          name: true,
          workspaceId: true,
          workspace: { select: { name: true } },
        },
      },
    },
  });

  const channelIds = memberships.map((m) => m.channelId);
  const channelMap = new Map(
    memberships.map((m) => [
      m.channelId,
      {
        channelName: m.channel.name,
        workspaceName: m.channel.workspace.name,
        workspaceId: m.channel.workspaceId,
      },
    ]),
  );

  const chatMsgs =
    channelIds.length > 0
      ? await db.chatMsg.findMany({
          where: {
            channelId: { in: channelIds },
            authorId: { not: userId },
            createdAt: { gt: sinceDate },
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          include: { author: { select: { login: true, avatarPath: true } } },
        })
      : [];

  // Global chat messages
  const globalMsgs = await db.globalChatMsg.findMany({
    where: {
      authorId: { not: userId },
      createdAt: { gt: sinceDate },
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    include: { author: { select: { login: true, avatarPath: true } } },
  });

  const messages = [
    ...chatMsgs.map((m) => {
      const ch = channelMap.get(m.channelId);
      return {
        id: m.id,
        type: "workspace" as const,
        author: m.author.login,
        hasAvatar: !!m.author.avatarPath,
        content: m.content.slice(0, 100),
        channelName: ch?.channelName ?? "Чат",
        workspaceName: ch?.workspaceName ?? "",
        workspaceId: ch?.workspaceId ?? "",
        createdAt: m.createdAt,
      };
    }),
    ...globalMsgs.map((m) => ({
      id: `g-${m.id}`,
      type: "global" as const,
      author: m.author.login,
      hasAvatar: !!m.author.avatarPath,
      content: m.content.slice(0, 100),
      channelName: "Общий чат",
      workspaceName: "",
      workspaceId: "",
      createdAt: m.createdAt,
    })),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Settings
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { chatSoundEnabled: true, chatDesktopNotify: true },
  });

  return NextResponse.json({
    messages: messages.slice(0, 5),
    settings: user,
  });
}
