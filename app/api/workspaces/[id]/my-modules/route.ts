import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Контракт ответа (как на origin/main): { allowedModules: <массив | null> }.
    // null = полный доступ. Потребители читают res.json().allowedModules.

    // ADMIN = full access
    if (session.user.role === "ADMIN") {
      return NextResponse.json({ allowedModules: null });
    }

    const workspaceId = params.id;
    const membership = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      select: { role: true, allowedModules: true },
    });

    // Не-участник — как на origin/main: полный доступ на уровне формы (реальный
    // доступ к воркспейсу режут другие гейты).
    if (!membership) {
      return NextResponse.json({ allowedModules: null });
    }

    // OWNER = full access
    if (membership.role === "OWNER") {
      return NextResponse.json({ allowedModules: null });
    }

    // Без ограничений = full access
    if (!membership.allowedModules) {
      return NextResponse.json({ allowedModules: null });
    }

    // Ограниченный член — отдаём распарсенный массив (битый JSON → null = full).
    try {
      const parsed = JSON.parse(membership.allowedModules) as unknown;
      return NextResponse.json({
        allowedModules: Array.isArray(parsed) ? (parsed as string[]) : null,
      });
    } catch {
      return NextResponse.json({ allowedModules: null });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
