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

        console.log("[auth] authorize called, loginOrEmail:", loginOrEmail);

        if (!loginOrEmail || !password) {
          console.log("[auth] missing credentials");
          return null;
        }

        const user = await db.user.findFirst({
          where: {
            OR: [{ email: loginOrEmail }, { login: loginOrEmail }],
          },
        });

        console.log(
          "[auth] user found:",
          !!user,
          "| isActive:",
          user?.isActive,
        );

        if (!user || !user.isActive) return null;

        const passwordMatch = await bcrypt.compare(password, user.password);
        console.log("[auth] passwordMatch:", passwordMatch);
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
      if (!appToken.id && token.sub) appToken.id = token.sub;
      const userId = appToken.id;
      console.log(
        "[auth] jwt callback, userId:",
        userId,
        "trigger:",
        user ? "sign-in" : "session-refresh",
      );
      if (userId) {
        const dbUser = await db.user.findUnique({
          where: { id: userId },
          select: { isActive: true, role: true },
        });
        console.log("[auth] jwt dbUser:", dbUser);
        if (!dbUser || !dbUser.isActive) {
          console.log("[auth] jwt returning null — user inactive or not found");
          return null;
        }
        appToken.role = dbUser.role;
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
