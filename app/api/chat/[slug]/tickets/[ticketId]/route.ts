import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import {
  verifyCustomerSession,
  unverifiedTicketFloor,
} from "@/lib/services/chat/customer-identity.service";
import { getTicketForCustomer } from "@/lib/services/tickets/ticket.service";
import {
  withCors,
  corsResponse,
  getEmbedOrigins,
} from "@/lib/services/chat/cors";
import { extractBearerToken } from "@/lib/services/chat/helpers";

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

    const ticket = await getTicketForCustomer(
      ticketId,
      customer.id,
      unverifiedTicketFloor(customer),
    );
    return withCors(NextResponse.json(ticket), origin, allowedOrigins);
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
    console.error("[GET /api/chat/tickets/:id]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
      allowedOrigins,
    );
  }
}
