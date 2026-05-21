import "server-only";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import type { JWT } from "next-auth/jwt";

/** Internal token shape with our custom fields */
interface AppJWT extends JWT {
  id: string;
  role: "ADMIN" | "USER";
}

// ═══════════════════════════════════════════════════════════════════════════
// In-memory cache for user isActive/role checks (60s TTL)
// Reduces DB queries from 1-per-request to 1-per-minute-per-user
// ═══════════════════════════════════════════════════════════════════════════

interface UserCacheEntry {
  isActive: boolean;
  role: "ADMIN" | "USER";
  expiresAt: number;
}

const userActiveCache = new Map<string, UserCacheEntry>();
const CACHE_TTL = 60_000; // 60 seconds
const CACHE_CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

function getCachedUser(
  userId: string,
): { isActive: boolean; role: "ADMIN" | "USER" } | null {
  const entry = userActiveCache.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) userActiveCache.delete(userId);
    return null;
  }
  return { isActive: entry.isActive, role: entry.role };
}

function setCachedUser(
  userId: string,
  isActive: boolean,
  role: "ADMIN" | "USER",
): void {
  userActiveCache.set(userId, {
    isActive,
    role,
    expiresAt: Date.now() + CACHE_TTL,
  });
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

export const { auth, handlers, signIn, signOut } = NextAuth({
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
    async jwt({ token, user }) {
      const appToken = token as Partial<AppJWT>;

      // On sign-in: persist custom fields to token
      if (user) {
        appToken.id = user.id as string;
        appToken.role = (user as { role: "ADMIN" | "USER" }).role;
      }

      // On every request: re-check isActive from DB (FR-004a)
      // Uses in-memory cache (60s TTL) to avoid DB query on every request
      if (!appToken.id && token.sub) appToken.id = token.sub;
      const userId = appToken.id;
      if (userId) {
        const cached = getCachedUser(userId);
        if (cached) {
          if (!cached.isActive) return null;
          appToken.role = cached.role;
        } else {
          const dbUser = await db.user.findUnique({
            where: { id: userId },
            select: { isActive: true, role: true },
          });
          if (!dbUser || !dbUser.isActive) {
            setCachedUser(userId, false, "USER");
            return null;
          }
          setCachedUser(userId, true, dbUser.role);
          appToken.role = dbUser.role;
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
