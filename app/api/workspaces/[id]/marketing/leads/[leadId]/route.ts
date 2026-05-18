import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getLead,
  updateLead,
  deleteLead,
} from "@/lib/services/marketing/mkt-lead.service";

type Params = { params: Promise<{ id: string; leadId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, leadId } = await params;

    const lead = await getLead(workspaceId, leadId);
    return NextResponse.json(lead);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, leadId } = await params;

    const body = await req.json();
    const lead = await updateLead(workspaceId, leadId, body);
    return NextResponse.json(lead);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, leadId } = await params;

    await deleteLead(workspaceId, leadId);
    return NextResponse.json({ ok: true });
  });
}
