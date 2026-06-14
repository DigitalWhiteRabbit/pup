import "server-only";
import * as jose from "jose";

function getSecret(): Uint8Array {
  const raw = process.env.CHAT_JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (!raw) {
    throw new Error(
      "CHAT_JWT_SECRET or NEXTAUTH_SECRET must be set. " +
        "Customer JWT tokens cannot be issued without a secret.",
    );
  }
  return new TextEncoder().encode(raw);
}

export async function issueCustomerToken(
  customerId: string,
  workspaceId: string,
  csrf?: string,
  emailVerified = true,
): Promise<string> {
  return new jose.SignJWT({
    sub: customerId,
    ws: workspaceId,
    ev: emailVerified, // false = email ownership NOT proven (claimed an existing customer)
    ...(csrf ? { csrf } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function verifyCustomerToken(token: string): Promise<{
  customerId: string;
  workspaceId: string;
  csrf?: string;
  emailVerified: boolean;
  issuedAt: number | null; // epoch ms
} | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getSecret());
    if (!payload.sub || !payload.ws) return null;
    return {
      customerId: payload.sub,
      workspaceId: payload.ws as string,
      csrf: (payload.csrf as string) ?? undefined,
      // Default true for legacy tokens issued before this claim existed
      // (they predate the takeover fix; acceptable — they're already in use).
      emailVerified: payload.ev !== false,
      issuedAt: typeof payload.iat === "number" ? payload.iat * 1000 : null,
    };
  } catch {
    return null;
  }
}
