import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string; docId: string }> };

// ── GET: get single doc with full content ──

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, docId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const doc = await db.mktKnowledgeDoc.findFirst({
      where: { id: docId, workspaceId },
      include: {
        chunks: {
          select: {
            id: true,
            position: true,
            chunkText: true,
            tokenCount: true,
          },
          orderBy: { position: "asc" },
        },
      },
    });

    if (!doc) {
      throw new ApiError("Document not found", "NOT_FOUND", 404);
    }

    return NextResponse.json(doc);
  });
}

// ── DELETE: remove doc and its chunks (cascade) ──

export async function DELETE(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, docId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    // Verify doc belongs to this workspace
    const doc = await db.mktKnowledgeDoc.findFirst({
      where: { id: docId, workspaceId },
      select: { id: true },
    });

    if (!doc) {
      throw new ApiError("Document not found", "NOT_FOUND", 404);
    }

    // Chunks are cascade-deleted via Prisma relation
    await db.mktKnowledgeDoc.delete({ where: { id: docId } });

    return NextResponse.json({ ok: true });
  });
}
