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

    const result = await authService.activateUser(params.id);
    return NextResponse.json(result);
  });
}
