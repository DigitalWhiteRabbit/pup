import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  listMessages,
  sendMessage,
} from "@/lib/services/chat-internal/message.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { enforceRateLimit } from "@/lib/services/rate-limit";

const sendSchema = z.object({
  content: z.string().min(1).max(10000),
  parentId: z.string().optional(),
  linkedTicketId: z.string().optional(),
  linkedTaskId: z.string().optional(),
  forwardedFromId: z.string().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; channelId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "chat",
    });
    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? undefined;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
      100,
    );
    const messages = await listMessages(
      channelId,
      session.user.id,
      workspaceId,
      { limit, before, role: session.user.role },
    );
    return NextResponse.json({ data: messages });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; channelId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // High ceiling — active chatting is legit; only catches scripted floods.
    // per-user only (perIp off): authenticated team chat behind one office NAT
    // must not collectively trip an IP cap; the 600/user bound suffices.
    const limited = enforceRateLimit({
      scope: "chat:message",
      userId: session.user.id,
      req,
      max: 600,
      windowMs: 60 * 60 * 1000,
      perIp: false,
    });
    if (limited) return limited;
    const { id: workspaceId, channelId } = await params;
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "chat",
    });
    const body: unknown = await req.json();
    const data = sendSchema.parse(body);
    const msg = await sendMessage(
      channelId,
      session.user.id,
      workspaceId,
      data,
      session.user.role,
    );
    return NextResponse.json(msg, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
