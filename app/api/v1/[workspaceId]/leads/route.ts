import { NextResponse } from "next/server";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/leads?status=pending&stage=not_contacted&limit=100&offset=0
 * Scope: leads:read
 *
 * Proxies to yt-parser (tools/yt-parser) which stores leads in a
 * per-workspace SQLite database. The yt-parser uses the `workspace`
 * query param or `x-workspace-id` header for workspace isolation.
 *
 * On local dev: http://localhost:3001
 * On prod: http://localhost:3001 (same box, PM2)
 */

const YT_PARSER_BASE = process.env.YT_PARSER_URL ?? "http://localhost:3001";

export const GET = withServiceAuth("leads:read", async (req, workspaceId) => {
  const url = new URL(req.url);

  // Forward supported query params to yt-parser
  const params = new URLSearchParams();
  params.set("workspace", workspaceId);

  const status = url.searchParams.get("status");
  if (status) params.set("status", status);

  const stage = url.searchParams.get("stage");
  if (stage) params.set("stage", stage);

  const limit = url.searchParams.get("limit");
  if (limit) params.set("limit", limit);

  const offset = url.searchParams.get("offset");
  if (offset) params.set("offset", offset);

  const targetUrl = `${YT_PARSER_BASE}/api/leads?${params.toString()}`;

  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "x-workspace-id": workspaceId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[v1/leads] yt-parser responded ${res.status}: ${body.slice(0, 500)}`,
      );
      return NextResponse.json(
        { error: "Upstream service error", status: res.status },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Distinguish timeout from connection refused
    if (message.includes("timeout") || message.includes("abort")) {
      console.error("[v1/leads] yt-parser timeout:", message);
      return NextResponse.json(
        { error: "Upstream service timeout" },
        { status: 504 },
      );
    }

    console.error("[v1/leads] yt-parser unreachable:", message);
    return NextResponse.json(
      { error: "Upstream service unavailable" },
      { status: 503 },
    );
  }
});
