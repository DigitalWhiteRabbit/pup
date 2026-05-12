import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  updateCannedResponse,
  deleteCannedResponse,
} from "@/lib/services/tickets/canned-response.service";

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).max(5000).optional(),
  category: z.string().max(100).nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; crId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { crId } = await params;
    const body: unknown = await request.json();
    const validated = updateSchema.parse(body);

    const cr = await updateCannedResponse(
      crId,
      validated,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(cr);
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[PATCH /canned-responses/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; crId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { crId } = await params;
    await deleteCannedResponse(
      crId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[DELETE /canned-responses/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
