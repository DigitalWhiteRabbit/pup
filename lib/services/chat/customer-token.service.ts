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
): Promise<string> {
  return new jose.SignJWT({
    sub: customerId,
    ws: workspaceId,
    ...(csrf ? { csrf } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function verifyCustomerToken(
  token: string,
): Promise<{ customerId: string; workspaceId: string; csrf?: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getSecret());
    if (!payload.sub || !payload.ws) return null;
    return {
      customerId: payload.sub,
      workspaceId: payload.ws as string,
      csrf: (payload.csrf as string) ?? undefined,
    };
  } catch {
    return null;
  }
}
