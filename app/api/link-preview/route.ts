import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  validateExternalUrl,
  readResponseWithLimit,
} from "@/lib/services/kb/url-validator";

const MAX_HTML_BYTES = 500 * 1024; // 500 KB
const FETCH_TIMEOUT_MS = 3000;

function extractMeta(html: string, property: string): string | null {
  // Match og:property or name=property meta tags
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? null;
}

// GET /api/link-preview?url=...
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const rawUrl = searchParams.get("url");
    if (!rawUrl)
      return NextResponse.json(
        { error: "Параметр url обязателен" },
        { status: 400 },
      );

    // SSRF protection: validate URL and resolve DNS
    const url = await validateExternalUrl(rawUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response!: Response;
    let finalUrl = url.toString();
    try {
      // Follow redirects manually to validate each hop against SSRF
      let hops = 0;
      while (hops < 3) {
        response = await fetch(finalUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "PUP-LinkPreview/1.0",
            Accept: "text/html",
          },
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const redirectUrl = new URL(location, finalUrl);
          await validateExternalUrl(redirectUrl.toString()); // SSRF check on redirect target
          finalUrl = redirectUrl.toString();
          hops++;
          continue;
        }
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok)
      return NextResponse.json(
        { error: "Не удалось загрузить страницу" },
        { status: 422 },
      );

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html"))
      return NextResponse.json({ error: "Не HTML страница" }, { status: 422 });

    const html = await readResponseWithLimit(response, MAX_HTML_BYTES);

    const title =
      extractMeta(html, "og:title") ??
      extractMeta(html, "twitter:title") ??
      extractTitle(html);
    const description =
      extractMeta(html, "og:description") ??
      extractMeta(html, "twitter:description") ??
      extractMeta(html, "description");
    const image =
      extractMeta(html, "og:image") ?? extractMeta(html, "twitter:image");

    return NextResponse.json({
      title: title ?? null,
      description: description ?? null,
      image: image ?? null,
      url: url.toString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Ошибка получения превью";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
