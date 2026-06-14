import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import { toggleReaction } from "@/lib/services/chat-internal/message.service";

const schema = z.object({ emoji: z.string().min(1).max(10) });

export async function POST(
  req: Request,
  {
    params,
  }: { params: Promise<{ id: string; channelId: string; messageId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, messageId } = await params;
    const { emoji } = schema.parse(await req.json());
    // Channel-level access (incl. cross-ws/channel scope) is enforced inside
    // toggleReaction via assertMessageChannelAccess.
    const result = await toggleReaction(
      messageId,
      session.user.id,
      emoji,
      workspaceId,
      session.user.role,
    );
    return NextResponse.json(result);
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
