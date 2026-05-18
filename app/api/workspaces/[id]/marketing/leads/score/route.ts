import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  scoreLead,
  scoreAllLeads,
  ScoreResult,
} from "@/lib/services/marketing/mkt-scoring.service";
import { ApiErrorResponse } from "@/lib/api-error";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(
    async (): Promise<
      NextResponse<ScoreResult | number | null | ApiErrorResponse>
    > => {
      const session = await auth();
      if (!session?.user?.id)
        throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
      const { id: workspaceId } = await params;

      const { leadId } = await req.json();

      if (leadId) {
        const result = await scoreLead(workspaceId, leadId);
        return NextResponse.json(result);
      }

      const result = await scoreAllLeads(workspaceId);
      return NextResponse.json(result);
    },
  );
}
