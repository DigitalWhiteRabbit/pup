import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/users
 * Scope: users:read
 *
 * Workspace members with roles and online status.
 */
export const GET = withServiceAuth("users:read", async (_req, workspaceId) => {
  const since = new Date(Date.now() - 5 * 60 * 1000); // 5 min

  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true,
          login: true,
          email: true,
          role: true,
          isActive: true,
          lastSeenAt: true,
          avatarPath: true,
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const data = members.map((m) => ({
    id: m.user.id,
    login: m.user.login,
    email: m.user.email,
    globalRole: m.user.role,
    workspaceRole: m.role,
    isActive: m.user.isActive,
    online: m.user.lastSeenAt ? m.user.lastSeenAt >= since : false,
    hasAvatar: !!m.user.avatarPath,
    joinedAt: m.joinedAt,
  }));

  return NextResponse.json({ data, total: data.length });
});
