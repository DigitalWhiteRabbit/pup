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

  // Handle CORS for public chat API — dynamic origin instead of wildcard
  if (pathname.startsWith("/api/chat/")) {
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-CSRF-Token",
        "Access-Control-Max-Age": "86400",
      };
      if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
      }
      return new NextResponse(null, { status: 204, headers });
    }

    // Non-preflight: attach CORS headers to the response
    const response = NextResponse.next();
    if (origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
    }
    return response;
  }

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
  matcher: [
    "/api/auth/callback/credentials",
    "/api/chat/:path*",
    "/chat/:path*",
  ],
};
