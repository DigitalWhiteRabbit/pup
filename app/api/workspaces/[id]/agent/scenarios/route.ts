import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  listScenarios,
  createScenario,
} from "@/lib/services/agent/agent.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  instruction: z.string().min(1).max(5000),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), id, {
      module: "tickets",
    });

    const list = await listScenarios(
      id,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ data: list });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), id, {
      module: "tickets",
    });

    const body: unknown = await request.json();
    const validated = createSchema.parse(body);
    const s = await createScenario(
      id,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(s, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
