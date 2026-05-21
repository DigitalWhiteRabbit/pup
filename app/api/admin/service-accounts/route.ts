import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { z } from "zod";
import {
  createServiceAccount,
  listServiceAccounts,
  VALID_SCOPES,
  type ServiceScope,
} from "@/lib/services/service-account.service";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPES as unknown as [string, ...string[]])),
  allowedIPs: z.array(z.string().ip()).optional(),
  workspaceId: z.string().min(1),
});

/** POST — Create a new service account. Returns the token ONCE. */
export async function POST(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const body: unknown = await req.json();
    const input = createSchema.parse(body);

    const { account, token } = await createServiceAccount({
      ...input,
      scopes: input.scopes as ServiceScope[],
    });

    return NextResponse.json({ ...account, token }, { status: 201 });
  });
}

/** GET — List service accounts for a workspace (query: ?workspaceId=...) */
export async function GET(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Admin access required", "FORBIDDEN", 403);
    }

    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) {
      throw new ApiError("workspaceId required", "VALIDATION_ERROR", 400);
    }

    const accounts = await listServiceAccounts(workspaceId);
    return NextResponse.json(accounts);
  });
}
