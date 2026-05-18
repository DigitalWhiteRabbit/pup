/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { onPendingReplyRejected } from "@/lib/services/marketing/mkt-worker.service";

type Params = { params: Promise<{ id: string; replyId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async (): Promise<NextResponse<any>> => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { replyId } = await params;

    const existing = await db.mktPendingReply.findUnique({
      where: { id: replyId },
    });
    if (!existing) throw new ApiError("Ответ не найден", "NOT_FOUND", 404);

    const { action, editedBody, editedSubject, notes } = await req.json();

    if (action === "approve") {
      const reply = await db.mktPendingReply.update({
        where: { id: replyId },
        data: {
          status: "APPROVED",
          editedBody: editedBody || undefined,
          editedSubject: editedSubject || undefined,
          adminNotes: notes || undefined,
          decidedAt: new Date(),
        },
      });
      return NextResponse.json(reply);
    }

    if (action === "reject") {
      const reply = await db.mktPendingReply.update({
        where: { id: replyId },
        data: {
          status: "REJECTED",
          adminNotes: notes || undefined,
          decidedAt: new Date(),
        },
      });
      await onPendingReplyRejected(reply.id);
      return NextResponse.json(reply);
    }

    if (action === "delete") {
      await db.mktPendingReply.delete({ where: { id: replyId } });
      return NextResponse.json({ ok: true });
    }

    throw new ApiError("Неверное действие", "BAD_REQUEST", 400);
  });
}
