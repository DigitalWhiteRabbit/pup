import "server-only";
import { db } from "@/lib/db";

/**
 * Lightweight membership check — no heavy imports.
 * Use this in API routes to avoid webpack bundling telegram/mailparser chain.
 */
export type MembershipRole = "OWNER" | "MEMBER" | null;

export async function checkMembership(
  workspaceId: string,
  userId: string,
): Promise<MembershipRole> {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  return membership.role;
}
