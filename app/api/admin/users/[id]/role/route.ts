import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { updateUserRoleSchema } from "@/lib/schemas/user.schema";
import * as authService from "@/lib/services/auth.service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Доступ запрещён", "FORBIDDEN", 403);
    }

    if (params.id === session.user.id) {
      throw new ApiError(
        "Нельзя изменить собственную роль. Попросите другого администратора",
        "CANNOT_CHANGE_OWN_ROLE",
        400,
      );
    }

    const body: unknown = await req.json();
    const { role } = updateUserRoleSchema.parse(body);

    const result = await authService.changeRole(params.id, role);
    return NextResponse.json(result);
  });
}
