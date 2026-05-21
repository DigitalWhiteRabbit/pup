import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { runYouTubeParser } from "@/lib/services/marketing/mkt-parser.service";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string }> };

// In-memory state for current parse job
let parseState: {
  running: boolean;
  logs: string[];
  result: { found: number; newLeads: number; quotaUsed?: number } | null;
  error: string | null;
  quotaUsed: number;
} = { running: false, logs: [], result: null, error: null, quotaUsed: 0 };

export async function POST(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    if (parseState.running) {
      return NextResponse.json({
        success: false,
        error: "Parser already running",
      });
    }

    const body = await req.json();

    // Reset state
    parseState = {
      running: true,
      logs: [],
      result: null,
      error: null,
      quotaUsed: 0,
    };

    // Start parsing in background (don't await)
    void (async () => {
      try {
        const result = await runYouTubeParser(
          { ...body, workspaceId },
          (msg: string) => {
            parseState.logs.push(msg);
          },
        );
        parseState.result = {
          found: result.found,
          newLeads: result.newLeads,
          quotaUsed: result.quotaUsed,
        };
        parseState.quotaUsed += result.quotaUsed || 0;
      } catch (e: unknown) {
        parseState.error = e instanceof Error ? e.message : "Unknown error";
        parseState.logs.push(`ERROR: ${parseState.error}`);
      } finally {
        parseState.running = false;
      }
    })();

    return NextResponse.json({ success: true });
  });
}

// GET /api/workspaces/[id]/marketing/parsers/run — status + logs
export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    return NextResponse.json({
      running: parseState.running,
      logs: parseState.logs,
      result: parseState.result,
      error: parseState.error,
    });
  });
}
