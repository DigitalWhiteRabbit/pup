import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import {
  verifyCustomerSession,
  unverifiedTicketFloor,
} from "@/lib/services/chat/customer-identity.service";
import { getTicketForCustomer } from "@/lib/services/tickets/ticket.service";
import { withCors, corsResponse } from "@/lib/services/chat/cors";
import { extractBearerToken } from "@/lib/services/chat/helpers";

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

    const ticket = await getTicketForCustomer(
      ticketId,
      customer.id,
      unverifiedTicketFloor(customer),
    );
    return withCors(NextResponse.json(ticket), origin);
  } catch (err) {
    if (err instanceof ApiError) {
      return withCors(
        NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        ),
        origin,
      );
    }
    console.error("[GET /api/chat/tickets/:id]", err);
    return withCors(
      NextResponse.json({ error: "Ошибка сервера" }, { status: 500 }),
      origin,
    );
  }
}
