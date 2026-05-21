import "server-only";
import { PrismaClient } from "@prisma/client";

// Production: set connection pool params in DATABASE_URL, e.g.:
//   DATABASE_URL="postgresql://...?connection_limit=10&pool_timeout=30"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
