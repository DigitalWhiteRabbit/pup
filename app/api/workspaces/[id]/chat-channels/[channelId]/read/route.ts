import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { markChannelRead } from "@/lib/services/chat-internal/message.service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; channelId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId } = await params;
    await markChannelRead(channelId, session.user.id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
