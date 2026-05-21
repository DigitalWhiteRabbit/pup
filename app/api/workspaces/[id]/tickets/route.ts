import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  createTicket,
  listTickets,
} from "@/lib/services/tickets/ticket.service";
import { ApiError } from "@/lib/api-error";
import { z } from "zod";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
  ServiceRateLimitError,
} from "@/lib/middleware/resolve-auth";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  category: z
    .enum(["FINANCIAL", "TECHNICAL", "GENERAL", "BUG", "FEATURE_REQUEST"])
    .optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  source: z.enum(["INTERNAL", "EXTERNAL"]).default("INTERNAL"),
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
  customerId: z.string().optional(),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  assigneeIds: z.string().optional(),
  search: z.string().optional(),
  slaBreached: z.string().optional(),
  sortBy: z
    .enum(["createdAt", "updatedAt", "priority", "slaDeadline"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await resolveAuth(request);
    if (!ctx)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    requireScope(ctx, "tickets:read");
    requireWorkspace(ctx, workspaceId);

    const url = new URL(request.url);
    const raw = Object.fromEntries(url.searchParams);
    const q = listSchema.parse(raw);

    const result = await listTickets(
      workspaceId,
      ctx.id,
      ctx.role as "ADMIN" | "USER",
      {
        page: q.page,
        pageSize: q.pageSize,
        status: q.status?.split(",") as never,
        priority: q.priority?.split(",") as never,
        category: q.category?.split(",") as never,
        source: q.source?.split(",") as never,
        assigneeIds: q.assigneeIds?.split(","),
        search: q.search,
        slaBreached:
          q.slaBreached === "true"
            ? true
            : q.slaBreached === "false"
              ? false
              : undefined,
        sortBy: q.sortBy,
        sortOrder: q.sortOrder,
      },
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceRateLimitError) return err.toResponse();
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /tickets]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    const body: unknown = await request.json();
    const validated = createSchema.parse(body);

    const ticket = await createTicket(
      { workspaceId, ...validated },
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(ticket, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[POST /tickets]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
