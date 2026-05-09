import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { getAllModules } from "@/lib/services/workspace.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const modules = await getAllModules(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(modules);
  });
}
