import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import {
  verifyCustomerSession,
  unverifiedTicketFloor,
} from "@/lib/services/chat/customer-identity.service";
import { checkRateLimit } from "@/lib/services/chat/rate-limit.service";
import {
  createTicketAsCustomer,
  listCustomerTickets,
} from "@/lib/services/tickets/ticket.service";
import {
  withCors,
  corsResponse,
  getEmbedOrigins,
} from "@/lib/services/chat/cors";
import {
  getClientIp,
  extractBearerToken,
  verifyCsrf,
} from "@/lib/services/chat/helpers";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  category: z
    .enum(["FINANCIAL", "TECHNICAL", "GENERAL", "BUG", "FEATURE_REQUEST"])
    .default("GENERAL"),
});

export async function OPTIONS(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  return corsResponse(request.headers.get("origin"), allowedOrigins);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const origin = request.headers.get("origin");
  const { slug } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json(
          { error: "Unauthorized", code: "UNAUTHORIZED" },
          { status: 401 },
        ),
        origin,
        allowedOrigins,
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
        allowedOrigins,
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
        allowedOrigins,
      );
    }

    const tickets = await listCustomerTickets(
      workspace.id,
      customer.id,
      unverifiedTicketFloor(customer),
    );
    return withCors(
      NextResponse.json({ data: tickets }),
      origin,
      allowedOrigins,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
        allowedOrigins,
      );
    }
    console.error("[GET /api/chat/tickets]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
      allowedOrigins,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const origin = request.headers.get("origin");
  const { slug } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json(
          { error: "Unauthorized", code: "UNAUTHORIZED" },
          { status: 401 },
        ),
        origin,
        allowedOrigins,
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
        allowedOrigins,
      );
    }

    const ip = getClientIp(request);
    const rl = checkRateLimit(`tickets:${ip}`, 30);
    if (!rl.allowed) {
      return withCors(
        NextResponse.json(
          { error: "Слишком много запросов", code: "RATE_LIMITED" },
          { status: 429 },
        ),
        origin,
        allowedOrigins,
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
        allowedOrigins,
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
        allowedOrigins,
      );
    }

    const body: unknown = await request.json();
    const validated = createSchema.parse(body);

    const ticket = await createTicketAsCustomer(
      workspace.id,
      customer.id,
      validated,
    );

    return withCors(
      NextResponse.json(ticket, { status: 201 }),
      origin,
      allowedOrigins,
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
        allowedOrigins,
      );
    }
    if (err instanceof ApiError) {
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
        allowedOrigins,
      );
    }
    console.error("[POST /api/chat/tickets]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
      allowedOrigins,
    );
  }
}
