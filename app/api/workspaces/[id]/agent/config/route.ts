import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  getAgentConfig,
  updateAgentConfig,
} from "@/lib/services/agent/agent.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["copilot", "autopilot"]).optional(),
  model: z.string().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  systemPrompt: z.string().max(5000).nullable().optional(),
  greeting: z.string().max(1000).nullable().optional(),
  guardrails: z.string().max(5000).nullable().optional(),
  handoffThreshold: z.number().min(0).max(1).optional(),
  autoResolve: z.boolean().optional(),
  autoFaq: z.boolean().optional(),
  autoContactNotes: z.boolean().optional(),
  useKnowledgeBase: z.boolean().optional(),
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

    const cfg = await getAgentConfig(
      id,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ config: cfg });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function PATCH(
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
    const validated = updateSchema.parse(body);
    await updateAgentConfig(
      id,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ ok: true });
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
