import { NextRequest, NextResponse } from "next/server";

const TG_SERVICE_URL = process.env.TG_SERVICE_URL || "http://localhost:8001";

async function proxyToTgService(
  req: NextRequest,
  { params }: { params: { id: string; path: string[] } },
) {
  const { id: workspaceId, path } = params;
  const pathStr = path.join("/");
  const url = new URL(`/api/v1/${pathStr}`, TG_SERVICE_URL);

  // Forward query params from the original request
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  // Always inject workspace identifier
  url.searchParams.set("workspace", workspaceId);

  const headers: Record<string, string> = {
    "x-workspace-id": workspaceId,
    "x-admin-token":
      process.env.TG_SERVICE_ADMIN_TOKEN || "dev-admin-token-12345",
  };

  // Forward content-type for requests with bodies
  const contentType = req.headers.get("content-type");
  const isMultipart = contentType?.startsWith("multipart/");

  // For multipart uploads, forward content-type with boundary intact
  if (contentType) headers["content-type"] = contentType;

  let body: BodyInit | undefined;
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    if (isMultipart) {
      // Forward raw binary body for multipart/form-data (file uploads)
      // Do NOT set content-type header — let the browser boundary propagate
      body = await req.arrayBuffer();
    } else {
      body = await req.text();
    }
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: body || undefined,
    });

    const data = await upstream.text();
    return new NextResponse(data, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    console.error("[tg-service proxy] upstream error:", err);
    return NextResponse.json(
      { error: "TG Service unavailable" },
      { status: 502 },
    );
  }
}

export const GET = proxyToTgService;
export const POST = proxyToTgService;
export const PATCH = proxyToTgService;
export const PUT = proxyToTgService;
export const DELETE = proxyToTgService;
