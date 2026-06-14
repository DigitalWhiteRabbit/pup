import { auth } from "@/lib/auth";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  addSSEClient,
  removeSSEClient,
} from "@/lib/services/chat-internal/sse.service";
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

/**
 * GET /api/workspaces/[id]/chat-channels/events
 *
 * Server-Sent Events endpoint for the internal chat module.
 * Pushes: new_message, message_edited, message_deleted, typing,
 * channel_created, channel_updated, channel_deleted, reaction_toggled,
 * message_pinned, online_status events.
 *
 * The client connects via EventSource and receives a JSON-encoded
 * event on each `data:` line.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: workspaceId } = await params;
  const userId = session.user.id;

  // Verify workspace membership (admins always pass)
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && session.user.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "chat",
    });
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      );
    throw e;
  }

  // ── Stream setup ────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const clientId =
    Math.random().toString(36).slice(2) + Date.now().toString(36);

  const stream = new ReadableStream({
    start(controller) {
      // Register this client in the in-memory registry
      addSSEClient(workspaceId, clientId, userId, controller, encoder);

      // Send initial "connected" event so the client knows the stream is live
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "connected", data: { clientId } })}\n\n`,
          ),
        );
      } catch {
        // Stream may already be closed
        return;
      }

      // ── Keepalive ─────────────────────────────────────────────────────
      // SSE connections can be dropped by proxies/load balancers if idle.
      // Send a comment line (`:`) every 25 seconds to keep the connection
      // alive through nginx (proxy_read_timeout default = 60s).
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 25_000);

      // ── Cleanup on disconnect ─────────────────────────────────────────
      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        removeSSEClient(workspaceId, clientId);
      });
    },
  });

  // ── Response ────────────────────────────────────────────────────────────
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent nginx from buffering SSE chunks
      "X-Accel-Buffering": "no",
    },
  });
}

// Opt out of static generation — this is a streaming endpoint
export const dynamic = "force-dynamic";
