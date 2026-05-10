import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { getSystemLogs } from "@/lib/services/logger.service";
import { z } from "zod";
import type { LogLevel } from "@prisma/client";

const filtersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  level: z.enum(["INFO", "WARN", "ERROR"]).optional(),
  source: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const { searchParams } = new URL(req.url);
    const parsed = filtersSchema.parse(Object.fromEntries(searchParams));

    const filters = {
      page: parsed.page,
      pageSize: parsed.pageSize,
      from: parsed.from ? new Date(parsed.from) : undefined,
      to: parsed.to ? new Date(parsed.to) : undefined,
      level: parsed.level as LogLevel | undefined,
      source: parsed.source,
    };

    const result = await getSystemLogs(
      params.id,
      session.user.id,
      session.user.role,
      filters,
    );

    return NextResponse.json(result);
  });
}
