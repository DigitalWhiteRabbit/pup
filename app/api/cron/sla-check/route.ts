import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { checkSlaBreaches } from "@/lib/services/tickets/sla-check.service";

/** Constant-time secret comparison (guards against timing attacks). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Cron endpoint: marks overdue tickets as SLA-breached across all workspaces.
 *
 * Replaces the in-process setInterval (which didn't survive restarts and would
 * double-run on multi-instance). Invoke from a scheduler with
 * `Authorization: Bearer <CRON_SECRET>`. Disabled (503) until CRON_SECRET is set.
 *
 * Owner action: add a crontab entry that runs every 5 minutes:
 *   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     http://127.0.0.1:3000/api/cron/sla-check >/dev/null
 * (schedule field: every-5-minutes, i.e. "[slash]5 * * * *").
 */
export async function POST(req: NextRequest) {
  const secret = process.env["CRON_SECRET"];
  if (!secret) {
    return NextResponse.json(
      { error: "SLA-cron выключен (CRON_SECRET не задан)" },
      { status: 503 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const summary = await checkSlaBreaches();
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[cron/sla-check]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ошибка проверки SLA" },
      { status: 500 },
    );
  }
}
