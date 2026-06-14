import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  verifyCustomerSession,
  unverifiedTicketFloor,
} from "@/lib/services/chat/customer-identity.service";
import { addMessageAsCustomer } from "@/lib/services/tickets/ticket.service";
import { checkRateLimit } from "@/lib/services/chat/rate-limit.service";
import { withCors, corsResponse } from "@/lib/services/chat/cors";
import {
  getClientIp,
  extractBearerToken,
  verifyCsrf,
} from "@/lib/services/chat/helpers";

const messageSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function OPTIONS(request: Request) {
  return corsResponse(request.headers.get("origin"));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const origin = request.headers.get("origin");
  try {
    const { slug, ticketId } = await params;
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json(
          { error: "Unauthorized", code: "UNAUTHORIZED" },
          { status: 401 },
        ),
        origin,
      );
    }

    const customer = await verifyCustomerSession(token, slug);
    if (!customer) {
      return withCors(
        NextResponse.json(
          { error: "Unauthorized", code: "UNAUTHORIZED" },
          { status: 401 },
        ),
        origin,
      );
    }

    const ip = getClientIp(request);
    const rl = checkRateLimit(`messages:${ip}`, 60);
    if (!rl.allowed) {
      return withCors(
        NextResponse.json(
          { error: "Слишком много запросов", code: "RATE_LIMITED" },
          { status: 429 },
        ),
        origin,
      );
    }

    // CSRF: verify against JWT claim
    const csrfValid = await verifyCsrf(request, token);
    if (!csrfValid) {
      return withCors(
        NextResponse.json(
          { error: "Неверный CSRF токен", code: "CSRF_INVALID" },
          { status: 403 },
        ),
        origin,
      );
    }

    const body: unknown = await request.json();
    const validated = messageSchema.parse(body);

    const message = await addMessageAsCustomer(
      ticketId,
      customer.id,
      validated.content,
      unverifiedTicketFloor(customer),
    );
    return withCors(NextResponse.json(message, { status: 201 }), origin);
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
    console.error("[POST /api/chat/tickets/:id/messages]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
    );
  }
}
