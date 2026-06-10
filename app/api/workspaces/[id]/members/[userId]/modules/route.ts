import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: { id: string; userId: string } };

const updateModulesSchema = z.object({
  allowedModules: z.array(z.string().min(1).max(100)).nullable(),
});

/** GET /api/workspaces/[id]/members/[userId]/modules */
export async function GET(_request: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session)
      return NextResponse.json(
        { error: "Не авторизован", code: "UNAUTHORIZED" },
        { status: 401 },
      );

    const member = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: params.id, userId: params.userId },
      },
      select: { role: true, allowedModules: true },
    });

    if (!member) {
      return NextResponse.json({ allowedModules: null });
    }

    // OWNERs always have full access
    if (member.role === "OWNER" || !member.allowedModules) {
      return NextResponse.json({ allowedModules: null });
    }

    let allowed: string[] | null = null;
    try {
      const parsed = JSON.parse(member.allowedModules) as unknown;
      if (Array.isArray(parsed)) allowed = parsed as string[];
    } catch {
      // invalid JSON — treat as null (full access)
    }

    return NextResponse.json({ allowedModules: allowed });
  } catch (err) {
    console.error("[modules] GET error:", err);
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}

/** PATCH /api/workspaces/[id]/members/[userId]/modules */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session)
      return NextResponse.json(
        { error: "Не авторизован", code: "UNAUTHORIZED" },
        { status: 401 },
      );

    const body: unknown = await request.json();
    const { allowedModules } = updateModulesSchema.parse(body);

    // Check requester is OWNER
    const requesterMembership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: params.id,
          userId: session.user.id,
        },
      },
      select: { role: true },
    });
    if (requesterMembership?.role !== "OWNER") {
      return NextResponse.json(
        {
          error: "Только владелец может управлять доступом к модулям",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Check target member exists
    const targetMembership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: params.id,
          userId: params.userId,
        },
      },
      select: { role: true },
    });

    if (!targetMembership) {
      return NextResponse.json(
        { error: "Участник не найден", code: "MEMBER_NOT_FOUND" },
        { status: 404 },
      );
    }

    if (targetMembership.role === "OWNER") {
      return NextResponse.json(
        {
          error: "Нельзя ограничить доступ владельца workspace",
          code: "CANNOT_RESTRICT_OWNER",
        },
        { status: 400 },
      );
    }

    await db.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId: params.id,
          userId: params.userId,
        },
      },
      data: {
        allowedModules:
          allowedModules === null ? null : JSON.stringify(allowedModules),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[modules] PATCH error:", err);
    return NextResponse.json(
      { error: "Internal server error", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
