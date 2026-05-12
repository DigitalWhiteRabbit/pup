import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { deleteScenario } from "@/lib/services/agent/agent.service";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; scenarioId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { scenarioId } = await params;
    await deleteScenario(
      scenarioId,
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
