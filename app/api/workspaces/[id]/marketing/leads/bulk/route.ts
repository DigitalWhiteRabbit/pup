import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { bulkUpdateStatus } from "@/lib/services/marketing/mkt-lead.service";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const { leadIds, status } = await req.json();
    if (!Array.isArray(leadIds) || !status) {
      throw new ApiError(
        "leadIds and status required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await bulkUpdateStatus(workspaceId, leadIds, status);
    return NextResponse.json(result);
  });
}
