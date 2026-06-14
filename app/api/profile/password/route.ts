import { auth, unstable_update, invalidateUserCache } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import bcrypt from "bcrypt";
import { enforceRateLimit } from "@/lib/services/rate-limit";

const PASSWORD_ERROR = "Минимум 8 символов, строчная и заглавная буква, цифра";

const schema = z.object({
  currentPassword: z.string().min(1, "Введите текущий пароль"),
  newPassword: z
    .string()
    .min(8, PASSWORD_ERROR)
    .regex(/[a-z]/, PASSWORD_ERROR)
    .regex(/[A-Z]/, PASSWORD_ERROR)
    .regex(/[0-9]/, PASSWORD_ERROR),
});

export async function PATCH(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Brute-force guard on currentPassword: 10 attempts / 15 min per user+IP.
    const limited = enforceRateLimit({
      scope: "profile:password",
      userId: session.user.id,
      req,
      max: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (limited) return limited;

    const body: unknown = await req.json();
    const { currentPassword, newPassword } = schema.parse(body);

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { password: true },
    });
    if (!user)
      return NextResponse.json(
        { error: "Пользователь не найден" },
        { status: 404 },
      );

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match)
      return NextResponse.json(
        { error: "Неверный текущий пароль" },
        { status: 400 },
      );

    const hash = await bcrypt.hash(newPassword, 10);
    await db.user.update({
      where: { id: session.user.id },
      data: { password: hash, passwordChangedAt: new Date() },
    });

    // Invalidate all OTHER active sessions: bust the user cache so other JWTs
    // are rejected on their next request (epoch now predates passwordChangedAt),
    // then re-issue THIS session's token so the current user stays logged in.
    invalidateUserCache(session.user.id);
    try {
      await unstable_update({});
    } catch (e) {
      // If re-issue fails the password is still changed (others invalidated);
      // this session would simply be logged out on its next request.
      console.warn("[password] session re-issue failed", e);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
