import { NextRequest, NextResponse } from "next/server";
import { listCustomers } from "@/lib/services/tickets/customer.service";
import { ApiError } from "@/lib/api-error";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
  ServiceRateLimitError,
} from "@/lib/middleware/resolve-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await resolveAuth(request);
    if (!ctx)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    requireScope(ctx, "customers:read");
    requireWorkspace(ctx, workspaceId);

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") ?? "1");
    const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20");
    const search = url.searchParams.get("search") ?? undefined;
    const result = await listCustomers(
      workspaceId,
      ctx.id,
      ctx.role as "ADMIN" | "USER",
      { page, pageSize, search },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceRateLimitError) return err.toResponse();
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /customers]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
