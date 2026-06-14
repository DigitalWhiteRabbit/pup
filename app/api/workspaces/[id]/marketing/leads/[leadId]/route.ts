import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getLead,
  updateLead,
  deleteLead,
} from "@/lib/services/marketing/mkt-lead.service";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: Promise<{ id: string; leadId: string }> };

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

/**
 * Allowed fields for PATCH /leads/:leadId.
 * Matches the updateLead() service contract exactly.
 * NEVER include: id, workspaceId, channelId, source, leadScore,
 * or any enrichment / metric field.
 */
const leadPatchSchema = z
  .object({
    leadStatus: MktLeadStatus.optional(),
    dialogueStage: MktDialogueStage.optional(),
    notes: z.string().max(10000).optional(),
    projectId: z.string().max(100).nullish(),
  })
  .strict();

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, leadId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

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

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    const body = await req.json();
    const parsed = leadPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        `Invalid fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        "VALIDATION_ERROR",
        400,
      );
    }
    const lead = await updateLead(workspaceId, leadId, parsed.data);
    return NextResponse.json(lead);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, leadId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    await deleteLead(workspaceId, leadId);
    return NextResponse.json({ ok: true });
  });
}
