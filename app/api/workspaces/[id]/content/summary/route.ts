import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { getSummary } from "@/lib/services/content.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: { id: string } };

/** GET — агрегаты для дашборда контент-плана */
export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);
    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "content",
    });

    const summary = await getSummary(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(summary);
  });
}
