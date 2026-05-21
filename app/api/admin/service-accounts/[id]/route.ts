import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { z } from "zod";
import {
  getServiceAccount,
  updateServiceAccount,
  deleteServiceAccount,
  rotateToken,
  VALID_SCOPES,
  type ServiceScope,
} from "@/lib/services/service-account.service";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopes: z
    .array(z.enum(VALID_SCOPES as unknown as [string, ...string[]]))
    .optional(),
  allowedIPs: z.array(z.string().ip()).nullable().optional(),
  isActive: z.boolean().optional(),
});

/** GET — Get a single service account */
export async function GET(_req: NextRequest, { params }: Ctx) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const { id } = await params;
    const account = await getServiceAccount(id);
    if (!account) throw new ApiError("Not found", "NOT_FOUND", 404);
    return NextResponse.json(account);
  });
}

/** PATCH — Update service account (name, scopes, allowedIPs, isActive) */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const { id } = await params;
    const body: unknown = await req.json();
    const input = updateSchema.parse(body);

    const account = await updateServiceAccount(id, {
      ...input,
      scopes: input.scopes as ServiceScope[] | undefined,
    });

    return NextResponse.json(account);
  });
}

/** DELETE — Remove a service account permanently */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const { id } = await params;
    await deleteServiceAccount(id);
    return new NextResponse(null, { status: 204 });
  });
}

/** POST — Rotate token (returns new token once) */
export async function POST(req: NextRequest, { params }: Ctx) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const { id } = await params;
    const { account, token } = await rotateToken(id);
    return NextResponse.json({ ...account, token });
  });
}
