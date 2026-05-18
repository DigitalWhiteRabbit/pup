import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  listLeads,
  createManualLead,
} from "@/lib/services/marketing/mkt-lead.service";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const url = req.nextUrl;
    const filters = {
      status: url.searchParams.get("status") || undefined,
      stage: url.searchParams.get("stage") || undefined,
      source: url.searchParams.get("source") || undefined,
      search: url.searchParams.get("search") || undefined,
      scoreLevel: url.searchParams.get("scoreLevel") || undefined,
      limit: url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
      offset: url.searchParams.get("offset")
        ? Number(url.searchParams.get("offset"))
        : undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listLeads(workspaceId, filters as any);
    return NextResponse.json(result);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const body = await req.json();
    const lead = await createManualLead(workspaceId, body);
    return NextResponse.json(lead, { status: 201 });
  });
}
