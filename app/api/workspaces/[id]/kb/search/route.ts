import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  searchArticles,
  getSearchHistory,
} from "@/lib/services/kb/search.service";
import { ApiError } from "@/lib/api-error";
import { z } from "zod";

const searchSchema = z.object({
  text: z.string().max(500).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  categoryIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  authorIds: z.array(z.string()).optional(),
  sourceTypes: z.array(z.enum(["MANUAL", "FILE", "URL"])).optional(),
  isPublished: z.boolean().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  updatedFrom: z.coerce.date().optional(),
  updatedTo: z.coerce.date().optional(),
  sortBy: z.enum(["relevance", "createdAt", "updatedAt", "title"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

// POST /api/workspaces/[id]/kb/search
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workspaceId } = await params;
    const body: unknown = await request.json();
    const query = searchSchema.parse(body);

    const result = await searchArticles(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
      query,
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[POST /kb/search]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

// GET /api/workspaces/[id]/kb/search — search history
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workspaceId } = await params;
    const history = await getSearchHistory(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(history);
  } catch (err) {
    console.error("[GET /kb/search]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
