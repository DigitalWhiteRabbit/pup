import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  editMessage,
  deleteMessage,
} from "@/lib/services/chat-internal/message.service";

const editSchema = z.object({ content: z.string().min(1).max(10000) });

export async function PATCH(
  req: Request,
  {
    params,
  }: { params: Promise<{ id: string; channelId: string; messageId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { messageId } = await params;
    const { content } = editSchema.parse(await req.json());
    await editMessage(messageId, session.user.id, content);
    return NextResponse.json({ ok: true });
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

export async function DELETE(
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
    await deleteMessage(
      messageId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
