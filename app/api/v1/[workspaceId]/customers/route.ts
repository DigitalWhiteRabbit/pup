import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/customers?search=&limit=50&offset=0
 * Scope: customers:read
 *
 * Customer list with ticket counts.
 */
export const GET = withServiceAuth(
  "customers:read",
  async (req, workspaceId) => {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") ?? undefined;
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") ?? "50"),
      200,
    );
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    const where: Record<string, unknown> = { workspaceId };
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { name: { contains: search } },
      ];
    }

    const [customers, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          email: true,
          name: true,
          externalId: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { tickets: true },
          },
        },
      }),
      db.customer.count({ where }),
    ]);

    const data = customers.map((c) => ({
      id: c.id,
      email: c.email,
      name: c.name,
      externalId: c.externalId,
      ticketsCount: c._count.tickets,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    return NextResponse.json({ data, total, limit, offset });
  },
);
