import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getMemberModuleAccess,
  setMemberModuleAccess,
} from "@/lib/services/member.service";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: { id: string; userId: string } };

const updateModulesSchema = z.object({
  allowedModules: z.array(z.string().min(1).max(100)).nullable(),
});

/** GET /api/workspaces/[id]/members/[userId]/modules */
export async function GET(_request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const allowed = await getMemberModuleAccess(params.id, params.userId);
    return NextResponse.json({ allowedModules: allowed });
  });
}

/** PATCH /api/workspaces/[id]/members/[userId]/modules */
export async function PATCH(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const { allowedModules } = updateModulesSchema.parse(body);

    await setMemberModuleAccess(
      params.id,
      params.userId,
      session.user.id,
      allowedModules,
    );

    return NextResponse.json({ ok: true });
  });
}
