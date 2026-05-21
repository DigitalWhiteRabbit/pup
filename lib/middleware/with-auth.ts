import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

type AuthHandler = (
  req: NextRequest,
  session: { user: { id: string; role: string; login: string } },
  params: Record<string, string>,
) => Promise<NextResponse>;

/**
 * Wraps an API route handler with session authentication.
 *
 * Eliminates the repetitive pattern of:
 *   const session = await auth();
 *   if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *
 * Usage:
 *   export const GET = withAuth(async (req, session, params) => {
 *     // session.user is guaranteed to exist here
 *     return NextResponse.json({ ok: true });
 *   });
 */
export function withAuth(handler: AuthHandler) {
  return async (
    req: NextRequest,
    ctx: { params: Promise<Record<string, string>> },
  ) => {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const params = await ctx.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return handler(req, session as any, params);
  };
}
