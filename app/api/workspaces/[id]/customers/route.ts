import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { listCustomers } from "@/lib/services/tickets/customer.service";
import { ApiError } from "@/lib/api-error";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId } = await params;
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") ?? "1");
    const pageSize = parseInt(url.searchParams.get("pageSize") ?? "20");
    const search = url.searchParams.get("search") ?? undefined;
    const result = await listCustomers(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
      { page, pageSize, search },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /customers]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
