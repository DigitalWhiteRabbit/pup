import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeFetch } from "@/lib/services/kb/url-validator";
import { NextRequest, NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

/** GET — get config status */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;

  const config = await db.externalUsersConfig.findUnique({
    where: { workspaceId },
    select: {
      id: true,
      apiEndpoint: true,
      authType: true,
      isConnected: true,
      lastSyncAt: true,
      lastError: true,
    },
  });

  return NextResponse.json({ config });
}

/** POST — create/update config */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const body = await req.json();

  const { apiEndpoint, apiKey, authType } = body as {
    apiEndpoint: string;
    apiKey: string;
    authType?: string;
  };

  if (!apiEndpoint || !apiKey)
    return NextResponse.json(
      { error: "apiEndpoint and apiKey required" },
      { status: 400 },
    );

  // Test connection — SSRF-safe: DNS-pinned, redirects revalidated, status
  // probe only (the endpoint is user-supplied, so this is an SSRF surface).
  let isConnected = false;
  let lastError: string | null = null;
  try {
    const headers: Record<string, string> = {};
    const at = authType ?? "bearer";
    if (at === "bearer") headers["Authorization"] = `Bearer ${apiKey}`;
    else if (at === "x-api-key") headers["X-API-Key"] = apiKey;

    const testUrl =
      at === "query"
        ? `${apiEndpoint}${apiEndpoint.includes("?") ? "&" : "?"}apiKey=${apiKey}`
        : apiEndpoint;

    const res = await safeFetch(testUrl, {
      headers,
      timeoutMs: 10000,
      readBody: false,
    });

    if (res.status >= 200 && res.status < 300) {
      isConnected = true;
    } else {
      lastError = `HTTP ${res.status}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Connection failed";
    lastError =
      msg.includes("blocked") || msg.includes("Protocol not allowed")
        ? "Blocked: endpoint resolves to internal network"
        : msg;
  }

  const config = await db.externalUsersConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      apiEndpoint,
      apiKey,
      authType: authType ?? "bearer",
      isConnected,
      lastError,
      lastSyncAt: isConnected ? new Date() : null,
    },
    update: {
      apiEndpoint,
      apiKey,
      authType: authType ?? "bearer",
      isConnected,
      lastError,
      lastSyncAt: isConnected ? new Date() : null,
    },
  });

  return NextResponse.json({
    isConnected: config.isConnected,
    lastError: config.lastError,
  });
}

/** PATCH — update config fields (without re-testing connection) */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const body = await req.json();

  const config = await db.externalUsersConfig.findUnique({
    where: { workspaceId },
  });
  if (!config)
    return NextResponse.json({ error: "Config not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.apiEndpoint) update.apiEndpoint = body.apiEndpoint;
  if (body.authType) update.authType = body.authType;

  const updated = await db.externalUsersConfig.update({
    where: { workspaceId },
    data: update,
    select: { id: true, apiEndpoint: true, authType: true, isConnected: true },
  });

  return NextResponse.json({ config: updated });
}

/** DELETE — disconnect */
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;

  await db.externalUsersConfig.deleteMany({ where: { workspaceId } });

  return NextResponse.json({ ok: true });
}
