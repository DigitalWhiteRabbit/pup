import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import { verifyCustomerSession } from "@/lib/services/chat/customer-identity.service";
import {
  rateTicket,
  getTicketRating,
} from "@/lib/services/tickets/rating.service";
import { withCors, corsResponse } from "@/lib/services/chat/cors";
import { extractBearerToken } from "@/lib/services/chat/helpers";

const rateSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

export async function OPTIONS(request: Request) {
  return corsResponse(request.headers.get("origin"));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const origin = request.headers.get("origin");
  try {
    const { slug, ticketId } = await params;
    const token = extractBearerToken(request);
    if (!token) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
      );
    }
    const customer = await verifyCustomerSession(token, slug);
    if (!customer) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
      );
    }

    const rating = await getTicketRating(ticketId);
    return withCors(NextResponse.json({ rating }), origin);
  } catch (err) {
    if (err instanceof ApiError)
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
      );
    return withCors(
      NextResponse.json({ error: "Ошибка" }, { status: 500 }),
      origin,
    );
  }
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
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
      );
    }
    const customer = await verifyCustomerSession(token, slug);
    if (!customer) {
      return withCors(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
      );
    }

    const body: unknown = await request.json();
    const validated = rateSchema.parse(body);

    const rating = await rateTicket(
      ticketId,
      customer.id,
      validated.score,
      validated.comment,
    );
    return withCors(NextResponse.json(rating, { status: 201 }), origin);
  } catch (err) {
    if (err instanceof z.ZodError)
      return withCors(
        NextResponse.json(
          { error: err.errors[0]?.message ?? "Ошибка" },
          { status: 400 },
        ),
        origin,
      );
    if (err instanceof ApiError)
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
      );
    console.error("[POST /rate]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка" }, { status: 500 }),
      origin,
    );
  }
}
