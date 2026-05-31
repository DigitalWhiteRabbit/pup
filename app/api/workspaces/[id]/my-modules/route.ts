import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // ADMIN = full access
    if (session.user.role === "ADMIN") {
      return NextResponse.json(null);
    }

    const workspaceId = params.id;
    const membership = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      select: { role: true, allowedModules: true },
    });

    if (!membership)
      return NextResponse.json({ error: "Not a member" }, { status: 403 });

    // OWNER = full access
    if (membership.role === "OWNER") {
      return NextResponse.json(null);
    }

    // Return parsed allowedModules or null (full access)
    if (!membership.allowedModules) {
      return NextResponse.json(null);
    }

    try {
      return NextResponse.json(JSON.parse(membership.allowedModules));
    } catch {
      return NextResponse.json(null);
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
