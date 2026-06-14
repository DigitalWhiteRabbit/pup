import "server-only";
import { NextResponse } from "next/server";

// The public chat widget is embeddable on arbitrary customer sites and is
// authenticated by Bearer token (NOT cookies). Previously this REFLECTED the
// caller's Origin back, which — paired with credentials — is dangerous. We do
// not echo the arbitrary origin; we return a static wildcard and never set
// Access-Control-Allow-Credentials, so reflected-origin credentialed requests
// are impossible. (A per-workspace embed-domain allowlist is a follow-up — it
// needs a new workspace setting that doesn't exist yet.)
export function corsHeaders(_origin?: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export function corsResponse(origin?: string | null) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export function withCors<T>(
  response: NextResponse<T>,
  origin?: string | null,
): NextResponse<T> {
  const headers = corsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) {
    response.headers.set(k, v);
  }
  return response;
}
