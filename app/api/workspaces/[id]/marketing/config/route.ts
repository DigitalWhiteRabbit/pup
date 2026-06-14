import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import {
  decryptConfig,
  encryptConfigFields,
} from "@/lib/services/crypto.service";

type Params = { params: Promise<{ id: string }> };

/**
 * Allowed fields for PATCH /config.
 * Sensitive fields (API keys, tokens, passwords) are accepted here
 * and encrypted before storage by encryptConfigFields().
 * NEVER include: id, workspaceId, createdAt, updatedAt.
 */
const configPatchSchema = z
  .object({
    // Sensitive fields — encrypted at rest via AES-256-GCM
    anthropicApiKey: z.string().max(500).nullish(),
    apifyToken: z.string().max(500).nullish(),
    resendApiKey: z.string().max(500).nullish(),
    imapPass: z.string().max(500).nullish(),
    youtubeApiKey: z.string().max(500).nullish(),
    tgApiHash: z.string().max(500).nullish(),
    tgSession: z.string().max(10000).nullish(),
    adminBotToken: z.string().max(500).nullish(),

    // AI models
    claudeModel: z.string().max(100).optional(),
    claudeModelSummary: z.string().max(100).optional(),
    claudeModelComplex: z.string().max(100).optional(),

    // Outreach limits
    dailyCapEmail: z.number().int().min(0).max(10000).optional(),
    dailyCapTg: z.number().int().min(0).max(10000).optional(),
    maxRepliesPerTick: z.number().int().min(0).max(100).optional(),
    loopMessageLimit: z.number().int().min(1).max(200).optional(),

    // Budget limits
    dailyBudgetApify: z.number().min(0).max(1000).optional(),
    monthlyBudgetApify: z.number().min(0).max(10000).optional(),
    dailyBudgetClaude: z.number().min(0).max(1000).optional(),
    monthlyBudgetClaude: z.number().min(0).max(10000).optional(),
    budgetAlertPercent: z.number().int().min(0).max(100).optional(),

    // Scoring
    scoreModelId: z.string().max(100).optional(),
    scoreThresholdHigh: z.number().min(0).max(1).optional(),
    scoreThresholdMedium: z.number().min(0).max(1).optional(),
    scoreMinSubscribers: z.number().int().min(0).optional(),
    scorePrompt: z.string().max(10000).nullish(),

    // Dedup rules
    dedupByEmail: z.boolean().optional(),
    dedupByUsername: z.boolean().optional(),
    dedupByNameGeo: z.boolean().optional(),

    // Worker
    reviewMode: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    followupEnabled: z.boolean().optional(),
    followupDelayDays: z.number().int().min(1).max(90).optional(),
    followupMaxAttempts: z.number().int().min(0).max(20).optional(),

    // Warm-up (graduated daily sending limits for new domains)
    warmupEnabled: z.boolean().optional(),
    warmupStartDate: z.string().datetime().nullish(),
    warmupSchedule: z.string().max(1000).nullish(),

    // Sender display (non-secret)
    resendSenderEmail: z.string().email().max(255).nullish(),
    resendSenderName: z.string().max(255).nullish(),
    imapHost: z.string().max(255).nullish(),
    imapPort: z.number().int().min(1).max(65535).nullish(),
    imapUser: z.string().max(255).nullish(),
    tgPhone: z.string().max(30).nullish(),
    tgApiId: z.string().max(50).nullish(),
    adminTgChatId: z.string().max(50).nullish(),
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

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    let config = await db.mktConfig.findUnique({ where: { workspaceId } });
    if (!config) {
      config = await db.mktConfig.create({ data: { workspaceId } });
    }

    // Decrypt sensitive fields before sending to client
    return NextResponse.json(decryptConfig(config));
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    const body = await req.json();
    const parsed = configPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        `Invalid fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        "VALIDATION_ERROR",
        400,
      );
    }

    // Ensure config exists
    await db.mktConfig.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });

    // Encrypt sensitive fields before writing to DB
    const data = encryptConfigFields(parsed.data as Record<string, unknown>);

    const config = await db.mktConfig.update({
      where: { workspaceId },
      data,
    });

    // Decrypt before returning so the client sees plaintext
    return NextResponse.json(decryptConfig(config));
  });
}
