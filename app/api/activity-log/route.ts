import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { z } from "zod";

// ─── Schema ──────────────────────────────────────────────────────────────────

const eventSchema = z.object({
  action: z.string().min(1).max(100),
  target: z.string().min(1).max(500),
  details: z.string().max(2000).optional(),
  timestamp: z.number().int().positive(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract workspaceId from a target pathname like "/workspaces/xxx/crm"
 */
function extractWorkspaceId(target: string): string | null {
  const match = target.match(/\/workspaces\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

// ─── POST /api/activity-log ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Unauthorized", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const { events } = batchSchema.parse(body);

    const userId = session.user.id;

    // Prepare records for batch insert
    const records = events.map((ev) => ({
      userId,
      workspaceId: extractWorkspaceId(ev.target),
      action: ev.action,
      target: ev.target,
      details: ev.details ?? null,
      occurredAt: new Date(ev.timestamp),
    }));

    // Batch insert all events
    await db.memberClickLog.createMany({ data: records });

    return NextResponse.json({ ok: true }, { status: 201 });
  });
}
