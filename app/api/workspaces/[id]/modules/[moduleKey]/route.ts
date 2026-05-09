import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { setModuleEnabled } from "@/lib/services/workspace.service";
import { setModuleEnabledSchema } from "@/lib/schemas/workspace.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string; moduleKey: string } };

export async function PATCH(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await request.json();
    const { enabled } = setModuleEnabledSchema.parse(body);

    await setModuleEnabled(
      params.id,
      params.moduleKey,
      enabled,
      session.user.id,
      session.user.role,
    );

    return NextResponse.json({ ok: true });
  });
}
