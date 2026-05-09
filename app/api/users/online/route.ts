import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes

  const users = await db.user.findMany({
    where: { lastSeenAt: { gte: since }, isActive: true },
    select: { id: true, login: true },
    orderBy: { lastSeenAt: "desc" },
  });

  return NextResponse.json(users);
}
