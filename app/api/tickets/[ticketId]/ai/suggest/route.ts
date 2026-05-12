import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { suggestReply } from "@/lib/services/agent/agent.service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ticketId } = await params;
    const result = await suggestReply(
      ticketId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[AI suggest]", err);
    return NextResponse.json({ error: "Ошибка AI" }, { status: 500 });
  }
}
