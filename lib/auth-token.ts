/**
 * Pure JWT password-epoch gate (no NextAuth/server-only imports → unit-testable).
 *
 * A token is stale if the user's password changed after the token was issued:
 * the token carries `pwdAt` (epoch ms at issue), and any token whose epoch
 * predates the user's current `passwordChangedAt` is rejected — which logs out
 * every session except the one re-issued during the password change itself.
 */
export function isTokenPasswordStale(
  tokenPwdAt: number | undefined,
  dbPwdAt: number,
): boolean {
  return dbPwdAt > (tokenPwdAt ?? 0);
}
