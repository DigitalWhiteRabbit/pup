import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { getMemberModuleAccess } from "@/lib/services/member.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

/** GET /api/workspaces/[id]/my-modules — returns the current user's allowed modules */
export async function GET(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    // ADMINs always have full access
    if (session.user.role === "ADMIN") {
      return NextResponse.json({ allowedModules: null });
    }

    const allowed = await getMemberModuleAccess(params.id, session.user.id);
    return NextResponse.json({ allowedModules: allowed });
  });
}
