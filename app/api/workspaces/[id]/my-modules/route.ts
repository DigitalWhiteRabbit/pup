import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { ApiError } from "@/lib/api-error";

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Контракт ответа: { allowedModules: <массив | null> }. null = полный доступ.
    // P0: non-member (non-admin) must be rejected — previously returned null
    // (full-access form) for anyone, leaking workspace existence + UI access.
    const access = await requireWorkspaceAccess(
      accessCtxFromSession(session),
      params.id,
    );
    return NextResponse.json({ allowedModules: access.allowedModules });
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      );
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
