import "server-only";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import type { JWT } from "next-auth/jwt";
import { isTokenPasswordStale } from "./auth-token";

export { isTokenPasswordStale } from "./auth-token";

/** Internal token shape with our custom fields */
interface AppJWT extends JWT {
  id: string;
  role: "ADMIN" | "USER";
  /** passwordChangedAt epoch (ms) captured when this token was (re)issued.
   *  If the user's DB passwordChangedAt later exceeds it, the token is stale. */
  pwdAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// In-memory cache for user isActive/role checks (60s TTL)
// Reduces DB queries from 1-per-request to 1-per-minute-per-user
// ═══════════════════════════════════════════════════════════════════════════

interface UserCacheEntry {
  isActive: boolean;
  role: "ADMIN" | "USER";
  /** passwordChangedAt epoch (ms); 0 if never changed. */
  pwdAt: number;
  expiresAt: number;
}

const userActiveCache = new Map<string, UserCacheEntry>();
const CACHE_TTL = 60_000; // 60 seconds
const CACHE_CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

function getCachedUser(
  userId: string,
): { isActive: boolean; role: "ADMIN" | "USER"; pwdAt: number } | null {
  const entry = userActiveCache.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) userActiveCache.delete(userId);
    return null;
  }
  return { isActive: entry.isActive, role: entry.role, pwdAt: entry.pwdAt };
}

function setCachedUser(
  userId: string,
  isActive: boolean,
  role: "ADMIN" | "USER",
  pwdAt: number,
): void {
  userActiveCache.set(userId, {
    isActive,
    role,
    pwdAt,
    expiresAt: Date.now() + CACHE_TTL,
  });
}

/** Bust the cached user record (called after a password change so OTHER
 *  sessions are invalidated on their next request, not after the 60s TTL). */
export function invalidateUserCache(userId: string): void {
  userActiveCache.delete(userId);
}

// Periodic cleanup to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  userActiveCache.forEach((entry, key) => {
    if (now > entry.expiresAt) {
      userActiveCache.delete(key);
    }
  });
}, CACHE_CLEANUP_INTERVAL).unref();

export const { auth, handlers, signIn, signOut, unstable_update } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        loginOrEmail: { label: "Login or Email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const loginOrEmail = credentials.loginOrEmail as string;
        const password = credentials.password as string;

        if (!loginOrEmail || !password) {
          return null;
        }

        // Case-insensitive: try exact first, then scan
        let user = await db.user.findFirst({
          where: {
            OR: [{ email: loginOrEmail }, { login: loginOrEmail }],
          },
        });
        if (!user) {
          const lower = loginOrEmail.toLowerCase();
          const candidates = await db.user.findMany({
            where: {
              OR: [
                { email: { contains: lower } },
                { login: { contains: lower } },
              ],
            },
            take: 10,
          });
          user =
            candidates.find(
              (u) =>
                u.login.toLowerCase() === lower ||
                u.email.toLowerCase() === lower,
            ) ?? null;
        }

        if (!user || !user.isActive) return null;

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.login,
          role: user.role,
          isActive: user.isActive,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      const appToken = token as Partial<AppJWT>;

      // On sign-in: persist custom fields to token
      if (user) {
        appToken.id = user.id as string;
        appToken.role = (user as { role: "ADMIN" | "USER" }).role;
      }

      // On every request: re-check isActive + password epoch from DB (FR-004a).
      // In-memory cache (60s TTL) avoids a DB query on every request.
      if (!appToken.id && token.sub) appToken.id = token.sub;
      const userId = appToken.id;
      if (userId) {
        let info = getCachedUser(userId);
        if (!info) {
          const dbUser = await db.user.findUnique({
            where: { id: userId },
            select: { isActive: true, role: true, passwordChangedAt: true },
          });
          if (!dbUser || !dbUser.isActive) {
            setCachedUser(userId, false, "USER", 0);
            return null;
          }
          const pwdAt = dbUser.passwordChangedAt
            ? dbUser.passwordChangedAt.getTime()
            : 0;
          setCachedUser(userId, true, dbUser.role, pwdAt);
          info = { isActive: true, role: dbUser.role, pwdAt };
        }
        if (!info.isActive) return null;
        appToken.role = info.role;

        // Password-change session invalidation:
        // - fresh issue (sign-in) or an explicit update() adopt the current epoch;
        // - any other (older) token whose epoch predates the DB change is killed.
        if (user || trigger === "update") {
          appToken.pwdAt = info.pwdAt;
        } else if (isTokenPasswordStale(appToken.pwdAt, info.pwdAt)) {
          return null;
        }
      }

      return appToken as AppJWT;
    },
    async session({ session, token }) {
      const appToken = token as Partial<AppJWT>;
      session.user.id = appToken.id ?? (token.sub as string);
      if (appToken.role) {
        session.user.role = appToken.role;
      }
      return session;
    },
  },
});
