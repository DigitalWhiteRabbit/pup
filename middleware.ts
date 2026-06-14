import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkAuthRateLimit } from "@/lib/services/auth/rate-limit";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate limit auth credential login attempts
  if (pathname === "/api/auth/callback/credentials") {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const { allowed, retryAfter } = checkAuthRateLimit(ip);
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many login attempts. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        },
      );
    }
  }

  // CORS for the public chat API is enforced at the ROUTE layer (Node runtime,
  // has DB access) via lib/services/chat/cors.ts — every /api/chat/* route has
  // its own OPTIONS handler + withCors so the per-workspace chatAllowedEmbedOrigins
  // allowlist can apply. It is intentionally NOT handled here: the edge runtime
  // can't read the DB, and reflecting an arbitrary Origin here would override
  // (and defeat) the route-level allowlist. Do not re-add CORS to middleware.

  // For embed pages: set CSP frame-ancestors
  if (pathname.startsWith("/chat/")) {
    const response = NextResponse.next();
    const embed = request.nextUrl.searchParams.get("embed");
    if (embed === "1") {
      response.headers.delete("X-Frame-Options");
      const origin =
        request.headers.get("origin") || request.headers.get("referer");
      let frameAncestor = "'self'";
      if (origin) {
        try {
          frameAncestor = new URL(origin).origin;
        } catch {
          // Malformed origin/referer — fall back to self only
        }
      }
      response.headers.set(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${frameAncestor}`,
      );
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/auth/callback/credentials", "/chat/:path*"],
};
