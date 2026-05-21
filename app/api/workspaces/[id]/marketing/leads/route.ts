import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  listLeads,
  createManualLead,
} from "@/lib/services/marketing/mkt-lead.service";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string }> };

const MktLeadStatus = z.enum([
  "PENDING",
  "READY",
  "IN_WORK",
  "DONE",
  "REJECTED",
]);
const MktDialogueStage = z.enum([
  "NOT_CONTACTED",
  "QUEUED",
  "AWAITING_REVIEW",
  "CONTACTED",
  "AWAITING_REPLY",
  "FOLLOWUP_1",
  "FOLLOWUP_2",
  "REPLIED",
  "NEGOTIATING",
  "DEAL_PENDING",
  "WON",
  "LOST",
]);
const MktLeadSource = z.enum([
  "YOUTUBE",
  "TELEGRAM",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "MANUAL",
]);

/** Schema for GET /leads query params — matches LeadFilters in the service */
const leadFiltersSchema = z.object({
  status: MktLeadStatus.optional(),
  stage: MktDialogueStage.optional(),
  source: MktLeadSource.optional(),
  search: z.string().max(200).optional(),
  scoreLevel: z.enum(["high", "medium", "low"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Schema for POST /leads — matches createManualLead() service contract */
const createLeadSchema = z
  .object({
    channelName: z.string().min(1).max(500),
    channelUrl: z.string().url().max(2000).optional(),
    source: MktLeadSource,
    email: z.string().email().max(255).optional(),
    telegram: z.string().max(255).optional(),
    notes: z.string().max(10000).optional(),
  })
  .strict();

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const url = req.nextUrl;
    const rawFilters = {
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

    const parsed = leadFiltersSchema.safeParse(rawFilters);
    if (!parsed.success) {
      throw new ApiError(
        `Invalid filters: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await listLeads(workspaceId, parsed.data);
    return NextResponse.json(result);
  });
}

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
    const parsed = createLeadSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        `Invalid fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        "VALIDATION_ERROR",
        400,
      );
    }
    const lead = await createManualLead(workspaceId, parsed.data);
    return NextResponse.json(lead, { status: 201 });
  });
}
