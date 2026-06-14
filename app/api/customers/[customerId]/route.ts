import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  getCustomer,
  updateCustomer,
} from "@/lib/services/tickets/customer.service";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().optional(),
  externalId: z.string().optional(),
});

async function requireCustomerAccess(
  session: { user: { id: string; role?: string | null } },
  customerId: string,
): Promise<void> {
  const ent = await db.customer.findUnique({
    where: { id: customerId },
    select: { workspaceId: true },
  });
  if (!ent) throw new ApiError("Клиент не найден", "NOT_FOUND", 404);
  await requireWorkspaceAccess(accessCtxFromSession(session), ent.workspaceId, {
    module: "tickets",
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { customerId } = await params;
    await requireCustomerAccess(session, customerId);
    const customer = await getCustomer(
      customerId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(customer);
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    console.error("[GET /customers/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { customerId } = await params;
    await requireCustomerAccess(session, customerId);
    const body: unknown = await request.json();
    const data = updateSchema.parse(body);
    const customer = await updateCustomer(
      customerId,
      data,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );
    return NextResponse.json(customer);
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
    console.error("[PATCH /customers/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
