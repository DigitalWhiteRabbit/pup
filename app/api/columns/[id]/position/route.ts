import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { reorderColumn } from "@/lib/services/column.service";
import { reorderColumnSchema } from "@/lib/schemas/column.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const input = reorderColumnSchema.parse(body);

    const result = await reorderColumn(
      params.id,
      input.position,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(result);
  });
}
