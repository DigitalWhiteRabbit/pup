import { db } from "@/lib/db";
import { NextResponse } from "next/server";

/**
 * GET /api/health
 *
 * Liveness/readiness probe. Checks database connectivity.
 * No auth required — used by deploy scripts and monitoring.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        error: e instanceof Error ? e.message : "DB unreachable",
      },
      { status: 503 },
    );
  }
}
