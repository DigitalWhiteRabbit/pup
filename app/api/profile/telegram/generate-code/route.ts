import { NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { db } from "@/lib/db";

export async function POST() {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const userId = session.user.id;

    // Delete old tokens for this user
    await db.telegramLinkToken.deleteMany({ where: { userId } });

    // Generate 16-char base62 token
    const bytes = crypto.randomBytes(12);
    const token = bytes.toString("base64url").slice(0, 16);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await db.telegramLinkToken.create({
      data: { userId, token, expiresAt },
    });

    const botUsername = process.env["TELEGRAM_BOT_USERNAME"] ?? "";

    return NextResponse.json({ code: token, expiresAt, botUsername });
  });
}
