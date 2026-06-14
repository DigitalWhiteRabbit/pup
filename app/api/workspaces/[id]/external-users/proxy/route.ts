import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { ApiError } from "@/lib/api-error";
import { safeFetch } from "@/lib/services/kb/url-validator";
import { NextRequest, NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/workspaces/[id]/external-users/proxy?path=/users&page=1&pageSize=50
 *
 * Proxies requests to the external API configured for this workspace.
 * Appends query params and auth headers automatically.
 * Caches responses for 60 seconds.
 */

const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL = 60_000; // 60 seconds

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;

  // Workspace membership + users-module access (global ADMIN passes).
  try {
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "users",
    });
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      );
    throw e;
  }

  const config = await db.externalUsersConfig.findUnique({
    where: { workspaceId },
  });

  if (!config || !config.isConnected)
    return NextResponse.json(
      { error: "External users not connected" },
      { status: 404 },
    );

  // Build target URL from external API endpoint + query params
  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  url.searchParams.delete("path");

  // Remaining search params forwarded to external API
  const forwardParams = new URLSearchParams();
  url.searchParams.forEach((v, k) => forwardParams.set(k, v));

  let targetUrl = config.apiEndpoint.replace(/\/$/, "");
  if (path) targetUrl += path.startsWith("/") ? path : `/${path}`;
  const qs = forwardParams.toString();
  if (qs) targetUrl += `${targetUrl.includes("?") ? "&" : "?"}${qs}`;

  if (config.authType === "query") {
    targetUrl += `${targetUrl.includes("?") ? "&" : "?"}apiKey=${config.apiKey}`;
  }

  // Check cache
  const cacheKey = `${workspaceId}:${targetUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data);
  }

  // Fetch from external API — SSRF-safe: DNS-pinned, redirects revalidated per
  // hop, response body size-capped (no DNS-rebind, no redirect-to-internal,
  // no unbounded res.json()).
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (config.authType === "bearer")
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    else if (config.authType === "x-api-key")
      headers["X-API-Key"] = config.apiKey;

    let res;
    try {
      res = await safeFetch(targetUrl, {
        headers,
        timeoutMs: 15000,
        maxBytes: 10 * 1024 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("blocked") ||
        msg.includes("Protocol not allowed") ||
        msg.includes("Invalid URL")
      ) {
        return NextResponse.json(
          { error: "Blocked: target URL resolves to internal network" },
          { status: 403 },
        );
      }
      throw err;
    }

    if (res.status < 200 || res.status >= 300) {
      // Update last error
      await db.externalUsersConfig.update({
        where: { workspaceId },
        data: { lastError: `HTTP ${res.status}`, lastSyncAt: new Date() },
      });
      return NextResponse.json(
        { error: `External API returned ${res.status}` },
        { status: 502 },
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(res.body);
    } catch {
      return NextResponse.json(
        { error: "External API returned non-JSON response" },
        { status: 502 },
      );
    }

    // Cache response
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL });

    // Update sync time
    await db.externalUsersConfig.update({
      where: { workspaceId },
      data: { lastSyncAt: new Date(), lastError: null, isConnected: true },
    });

    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fetch failed";
    await db.externalUsersConfig.update({
      where: { workspaceId },
      data: { lastError: msg, lastSyncAt: new Date() },
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
