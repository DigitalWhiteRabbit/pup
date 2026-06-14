import "server-only";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// The public chat widget is embeddable on customer sites and is authenticated by
// Bearer token (NOT cookies). We NEVER set Access-Control-Allow-Credentials, so
// reflected-origin credentialed attacks are impossible regardless of ACAO.
//
// Per-workspace allowlist (chatAllowedEmbedOrigins, a JSON array of origins):
//  - not configured (the default for every workspace today) → static "*", so the
//    widget keeps working on any embedding site (no breakage);
//  - configured → echo the caller Origin ONLY if it is on the list (+ Vary:
//    Origin); a non-listed Origin gets a non-matching ACAO so the browser blocks
//    it. Arbitrary Origins are never reflected back when an allowlist exists.

/** Parse the stored JSON-array string into a clean origin list (safe on junk). */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is string => typeof o === "string" && o.length > 0,
    );
  } catch {
    return [];
  }
}

/** Resolve a workspace's embed-origin allowlist by public chat slug.
 *  Fail-open to [] (→ static "*") on any DB error so a transient blip can't
 *  turn into a cors-less 500 on these public endpoints. */
export async function getEmbedOrigins(slug: string): Promise<string[]> {
  try {
    const ws = await db.workspace.findUnique({
      where: { slug },
      select: { chatAllowedEmbedOrigins: true },
    });
    return parseAllowedOrigins(ws?.chatAllowedEmbedOrigins);
  } catch {
    return [];
  }
}

/** Decide the Access-Control-Allow-Origin value. */
function resolveAcao(
  origin: string | null | undefined,
  allowed: string[],
): string {
  if (allowed.length === 0) return "*"; // no allowlist → permissive (no creds)
  if (origin && allowed.includes(origin)) return origin; // listed → echo
  return allowed[0]!; // configured but caller not listed → non-matching → blocked
}

export function corsHeaders(
  origin?: string | null,
  allowed: string[] = [],
): Record<string, string> {
  const acao = resolveAcao(origin, allowed);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": acao,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Access-Control-Max-Age": "86400",
  };
  // When the response varies by Origin, caches must not share it across origins.
  if (acao !== "*") headers["Vary"] = "Origin";
  return headers;
}

export function corsResponse(origin?: string | null, allowed: string[] = []) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin, allowed),
  });
}

export function withCors<T>(
  response: NextResponse<T>,
  origin?: string | null,
  allowed: string[] = [],
): NextResponse<T> {
  const headers = corsHeaders(origin, allowed);
  for (const [k, v] of Object.entries(headers)) {
    response.headers.set(k, v);
  }
  return response;
}
