import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { identifyOrCreateCustomer } from "@/lib/services/chat/customer-identity.service";
import { checkRateLimit } from "@/lib/services/chat/rate-limit.service";
import { withCors, corsResponse } from "@/lib/services/chat/cors";
import { getClientIp } from "@/lib/services/chat/helpers";
import type { CustomerIdentityMethod } from "@prisma/client";

const identifySchema = z.object({
  method: z.enum([
    "EMAIL_WITH_NAME",
    "EMAIL_ONLY",
    "ANONYMOUS",
    "TELEGRAM_LOGIN",
  ]),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
  telegramChatId: z.string().optional(),
  telegramName: z.string().optional(),
});

export async function OPTIONS(request: Request) {
  return corsResponse(request.headers.get("origin"));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const origin = request.headers.get("origin");
  try {
    const { slug } = await params;
    const ip = getClientIp(request);

    // Rate limit: 5 identifications per minute
    const rl = checkRateLimit(`identify:${ip}`, 5, 60 * 1000);
    if (!rl.allowed) {
      return withCors(
        NextResponse.json(
          { error: "Слишком много запросов", code: "RATE_LIMITED" },
          { status: 429 },
        ),
        origin,
      );
    }

    const workspace = await db.workspace.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!workspace) {
      return withCors(
        NextResponse.json(
          { error: "Не найдено", code: "NOT_FOUND" },
          { status: 404 },
        ),
        origin,
      );
    }

    const body: unknown = await request.json();
    const validated = identifySchema.parse(body);

    const result = await identifyOrCreateCustomer(workspace.id, {
      method: validated.method as CustomerIdentityMethod,
      email: validated.email,
      name: validated.name,
      telegramChatId: validated.telegramChatId,
      telegramName: validated.telegramName,
    });

    return withCors(
      NextResponse.json({
        customer: {
          id: result.customer.id,
          email: result.customer.email,
          name: result.customer.name,
        },
        token: result.token,
        csrf: result.csrf,
      }),
      origin,
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return withCors(
        NextResponse.json(
          {
            error: err.errors[0]?.message ?? "Ошибка валидации",
            code: "VALIDATION_ERROR",
          },
          { status: 400 },
        ),
        origin,
      );
    }
    if (err instanceof ApiError) {
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
      );
    }
    console.error("[POST /api/chat/identify]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
    );
  }
}
