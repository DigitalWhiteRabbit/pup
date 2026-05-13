import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { getThreadReplies } from "@/lib/services/chat-internal/message.service";

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ id: string; channelId: string; messageId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { messageId } = await params;
    const replies = await getThreadReplies(messageId, session.user.id);
    return NextResponse.json({ data: replies });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
