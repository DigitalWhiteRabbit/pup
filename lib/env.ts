import { z } from "zod";

/**
 * Validated environment variables.
 *
 * This module runs validation at import-time so the app fails fast
 * if critical secrets are missing or still contain placeholder values.
 * Import from instrumentation.ts to enforce at startup.
 */

const envSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL must not be empty"),

  AUTH_SECRET: z
    .string({ required_error: "AUTH_SECRET is required" })
    .min(1, "AUTH_SECRET must not be empty")
    .refine(
      (val) =>
        !val.includes("change-in-production") && !val.includes("your-secret"),
      "AUTH_SECRET still contains a placeholder value — generate a real secret with: openssl rand -base64 32",
    ),

  NEXTAUTH_SECRET: z
    .string({ required_error: "NEXTAUTH_SECRET is required" })
    .min(1, "NEXTAUTH_SECRET must not be empty"),

  CHAT_JWT_SECRET: z
    .string({ required_error: "CHAT_JWT_SECRET is required" })
    .min(16, "CHAT_JWT_SECRET must be at least 16 characters"),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const formatted = Object.entries(errors)
      .map(([key, msgs]) => `  ${key}: ${msgs?.join(", ")}`)
      .join("\n");

    console.error(
      `\n[env] Environment validation failed:\n${formatted}\n\nFix your .env file and restart.\n`,
    );
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();
