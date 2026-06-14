import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import {
  verifyCustomerSession,
  unverifiedTicketFloor,
} from "@/lib/services/chat/customer-identity.service";
import {
  rateTicket,
  getTicketRating,
} from "@/lib/services/tickets/rating.service";
import {
  withCors,
  corsResponse,
  getEmbedOrigins,
} from "@/lib/services/chat/cors";
import { extractBearerToken } from "@/lib/services/chat/helpers";

const rateSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

export async function OPTIONS(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  return corsResponse(request.headers.get("origin"), allowedOrigins);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const origin = request.headers.get("origin");
  const { slug, ticketId } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
        allowedOrigins,
      );
    }
    const customer = await verifyCustomerSession(token, slug);
    if (!customer) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
        allowedOrigins,
      );
    }

    const rating = await getTicketRating(
      ticketId,
      customer.id,
      unverifiedTicketFloor(customer),
    );
    return withCors(NextResponse.json({ rating }), origin, allowedOrigins);
  } catch (err) {
    if (err instanceof ApiError)
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
        allowedOrigins,
      );
    return withCors(
      NextResponse.json({ error: "Ошибка" }, { status: 500 }),
      origin,
      allowedOrigins,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const origin = request.headers.get("origin");
  const { slug, ticketId } = await params;
  const allowedOrigins = await getEmbedOrigins(slug);
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
        allowedOrigins,
      );
    }
    const customer = await verifyCustomerSession(token, slug);
    if (!customer) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
        allowedOrigins,
      );
    }

    const body: unknown = await request.json();
    const validated = rateSchema.parse(body);

    const rating = await rateTicket(
      ticketId,
      customer.id,
      validated.score,
      validated.comment,
      unverifiedTicketFloor(customer),
    );
    return withCors(
      NextResponse.json(rating, { status: 201 }),
      origin,
      allowedOrigins,
    );
  } catch (err) {
    if (err instanceof z.ZodError)
      return withCors(
        NextResponse.json(
          { error: err.errors[0]?.message ?? "Ошибка" },
          { status: 400 },
        ),
        origin,
        allowedOrigins,
      );
    if (err instanceof ApiError)
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
        allowedOrigins,
      );
    console.error("[POST /rate]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка" }, { status: 500 }),
      origin,
      allowedOrigins,
    );
  }
}
