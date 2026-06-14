import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeFetch } from "@/lib/services/kb/url-validator";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { encrypt } from "@/lib/services/crypto.service";
import { ApiError } from "@/lib/api-error";
import { NextRequest, NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

/** Membership gate for the users module; returns a 403 response or null. */
async function guardUsers(
  session: { user: { id: string; role?: string | null } },
  workspaceId: string,
): Promise<NextResponse | null> {
  try {
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "users",
    });
    return null;
  } catch (e) {
    if (e instanceof ApiError)
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      );
    throw e;
  }
}

/** GET — get config status */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const denied = await guardUsers(session, workspaceId);
  if (denied) return denied;

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
  const denied = await guardUsers(session, workspaceId);
  if (denied) return denied;

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

  // Encrypt the upstream key at rest (graceful-decrypt on read for legacy rows).
  const encryptedKey = encrypt(apiKey);
  const config = await db.externalUsersConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      apiEndpoint,
      apiKey: encryptedKey,
      authType: authType ?? "bearer",
      isConnected,
      lastError,
      lastSyncAt: isConnected ? new Date() : null,
    },
    update: {
      apiEndpoint,
      apiKey: encryptedKey,
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
  const denied = await guardUsers(session, workspaceId);
  if (denied) return denied;

  const body = await req.json();

  const config = await db.externalUsersConfig.findUnique({
    where: { workspaceId },
  });
  if (!config)
    return NextResponse.json({ error: "Config not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.authType) update.authType = body.authType;

  // SECURITY (key-theft): changing the endpoint must NOT carry the saved upstream
  // key over to a new (possibly attacker-controlled) host. Invalidate the stored
  // key + disconnect → the proxy refuses until the key is re-entered via POST
  // (which re-tests the connection against the new endpoint).
  if (body.apiEndpoint && body.apiEndpoint !== config.apiEndpoint) {
    update.apiEndpoint = body.apiEndpoint;
    update.apiKey = "";
    update.isConnected = false;
    update.lastError = "Endpoint изменён — введите API-ключ заново";
  } else if (body.apiEndpoint) {
    update.apiEndpoint = body.apiEndpoint;
  }

  const updated = await db.externalUsersConfig.update({
    where: { workspaceId },
    data: update,
    select: {
      id: true,
      apiEndpoint: true,
      authType: true,
      isConnected: true,
      lastError: true,
    },
  });

  return NextResponse.json({ config: updated });
}

/** DELETE — disconnect */
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const denied = await guardUsers(session, workspaceId);
  if (denied) return denied;

  await db.externalUsersConfig.deleteMany({ where: { workspaceId } });

  return NextResponse.json({ ok: true });
}
