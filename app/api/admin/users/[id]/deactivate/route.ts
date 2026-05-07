import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import * as authService from "@/lib/services/auth.service";

export async function PATCH(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Доступ запрещён", "FORBIDDEN", 403);
    }

    if (params.id === session.user.id) {
      throw new ApiError(
        "Нельзя деактивировать собственную учётную запись",
        "CANNOT_DEACTIVATE_SELF",
        400,
      );
    }

    const result = await authService.deactivateUser(params.id);
    return NextResponse.json(result);
  });
}
