import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle CORS preflight for public chat API
  if (pathname.startsWith("/api/chat/")) {
    if (request.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-CSRF-Token",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
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
