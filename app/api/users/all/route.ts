import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 5 * 60 * 1000);

  const users = await db.user.findMany({
    where: { isActive: true },
    select: {
      id: true,
      login: true,
      role: true,
      lastSeenAt: true,
      avatarPath: true,
    },
    orderBy: { login: "asc" },
  });

  const result = users.map((u) => ({
    id: u.id,
    login: u.login,
    role: u.role,
    hasAvatar: !!u.avatarPath,
    online: u.lastSeenAt ? u.lastSeenAt >= since : false,
  }));

  return NextResponse.json(result);
}
