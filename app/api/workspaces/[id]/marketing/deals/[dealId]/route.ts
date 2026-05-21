import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string; dealId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, dealId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const existing = await db.mktDeal.findFirst({
      where: { id: dealId, lead: { workspaceId } },
    });
    if (!existing) throw new ApiError("Сделка не найдена", "NOT_FOUND", 404);

    const { decision, notes } = await req.json();
    if (!["APPROVED", "REJECTED"].includes(decision)) {
      throw new ApiError("Неверное решение", "BAD_REQUEST", 400);
    }

    const deal = await db.mktDeal.update({
      where: { id: dealId },
      data: {
        adminDecision: decision,
        adminNotes: notes || null,
        decidedAt: new Date(),
      },
    });
    return NextResponse.json(deal);
  });
}
