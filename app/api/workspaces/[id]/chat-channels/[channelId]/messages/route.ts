import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  listMessages,
  sendMessage,
} from "@/lib/services/chat-internal/message.service";

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
    const { channelId } = await params;
    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? undefined;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
      100,
    );
    const messages = await listMessages(channelId, session.user.id, {
      limit,
      before,
    });
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
    const { channelId } = await params;
    const body: unknown = await req.json();
    const data = sendSchema.parse(body);
    const msg = await sendMessage(channelId, session.user.id, data);
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
