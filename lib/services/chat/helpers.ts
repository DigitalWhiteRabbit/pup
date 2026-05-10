import "server-only";
import { verifyCustomerToken } from "./customer-token.service";

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

/**
 * Verify CSRF token by comparing the X-CSRF-Token header
 * against the csrf claim embedded in the customer JWT.
 */
export async function verifyCsrf(
  request: Request,
  token: string,
): Promise<boolean> {
  const csrfHeader = request.headers.get("x-csrf-token");
  if (!csrfHeader) return false;

  const payload = await verifyCustomerToken(token);
  if (!payload?.csrf) return false;

  return csrfHeader === payload.csrf;
}
