import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
      // Allow framing from any origin (workspace-specific checks happen at API level)
      response.headers.delete("X-Frame-Options");
      response.headers.set("Content-Security-Policy", "frame-ancestors *");
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/chat/:path*", "/chat/:path*"],
};
