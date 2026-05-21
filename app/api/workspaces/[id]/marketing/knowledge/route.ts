import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string }> };

// ── Chunking ──

function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for mixed content
  return Math.ceil(text.length / 4);
}

// ── Validation ──

const createDocSchema = z
  .object({
    title: z.string().min(1).max(500),
    content: z.string().min(1).max(500_000),
    kind: z.enum(["text", "file", "url"]).default("text"),
    source: z.string().max(2000).nullish(),
    projectId: z.string().max(100).nullish(),
  })
  .strict();

// ── GET: list all knowledge docs for workspace ──

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const docs = await db.mktKnowledgeDoc.findMany({
      where: { workspaceId },
      select: {
        id: true,
        title: true,
        kind: true,
        source: true,
        status: true,
        chunksCount: true,
        sizeBytes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ docs });
  });
}

// ── POST: create a new knowledge document ──

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const body = await req.json();
    const parsed = createDocSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        `Invalid fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        "VALIDATION_ERROR",
        400,
      );
    }

    const { title, content, kind, source, projectId } = parsed.data;

    // Create document
    const doc = await db.mktKnowledgeDoc.create({
      data: {
        workspaceId,
        title,
        content,
        kind,
        source: source ?? null,
        projectId: projectId ?? null,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
        status: "INDEXING",
      },
    });

    // Chunk the content
    try {
      const textChunks = chunkText(content);
      const chunkData = textChunks.map((chunk, i) => ({
        docId: doc.id,
        position: i,
        chunkText: chunk,
        tokenCount: estimateTokens(chunk),
      }));

      await db.mktKnowledgeChunk.createMany({ data: chunkData });

      // Update doc with chunk count and status
      const updatedDoc = await db.mktKnowledgeDoc.update({
        where: { id: doc.id },
        data: {
          chunksCount: chunkData.length,
          status: "INDEXED",
        },
      });

      return NextResponse.json(updatedDoc, { status: 201 });
    } catch (err) {
      // Mark as failed if chunking fails
      await db.mktKnowledgeDoc.update({
        where: { id: doc.id },
        data: {
          status: "FAILED",
          error: err instanceof Error ? err.message : "Chunking failed",
        },
      });
      throw new ApiError("Failed to index document", "INDEXING_ERROR", 500);
    }
  });
}
