import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { getSummary } from "@/lib/services/content.service";

type Params = { params: { id: string } };

/** GET — агрегаты для дашборда контент-плана */
export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const summary = await getSummary(
      params.id,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(summary);
  });
}
