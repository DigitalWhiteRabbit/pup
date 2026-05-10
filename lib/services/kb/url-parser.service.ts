import "server-only";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { ApiError } from "@/lib/api-error";
import { validateExternalUrl, readResponseWithLimit } from "./url-validator";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gfm } = require("turndown-plugin-gfm") as {
  gfm: (service: TurndownService) => void;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.use(gfm);
// Remove noisy HTML elements (tag names only — TurndownService accepts tag names)
turndown.remove(["script", "style", "nav", "footer", "aside", "header"]);

export type UrlParseResult = {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  links: string[];
  metadata: {
    description?: string;
    fetchedAt: Date;
    statusCode: number;
    contentType: string;
  };
};

export async function parseUrl(
  url: string,
  options?: { timeout?: number; userAgent?: string; _redirectDepth?: number },
): Promise<UrlParseResult> {
  const redirectDepth = options?._redirectDepth ?? 0;
  if (redirectDepth > 5) {
    throw new ApiError("Слишком много редиректов", "TOO_MANY_REDIRECTS", 400);
  }
  // Validate URL — SSRF protection
  let parsed: URL;
  try {
    parsed = await validateExternalUrl(url);
  } catch (err: unknown) {
    throw new ApiError(
      (err as Error).message || "Некорректный URL",
      "INVALID_URL",
      400,
    );
  }

  const timeout = options?.timeout ?? 30000;
  const userAgent =
    options?.userAgent ??
    "PupKnowledgeBaseBot/1.0 (compatible; +https://pup.local)";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });
  } catch (err: unknown) {
    if ((err as Error).name === "AbortError") {
      throw new ApiError("Превышено время ожидания", "URL_FETCH_TIMEOUT", 408);
    }
    throw new ApiError(
      `Ошибка загрузки URL: ${(err as Error).message}`,
      "URL_FETCH_FAILED",
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  // Handle redirects manually — validate each Location against SSRF
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new ApiError(
        "Redirect без Location header",
        "URL_FETCH_FAILED",
        502,
      );
    }
    const redirectUrl = new URL(location, url).href;
    // Recursive call validates the redirect target
    return parseUrl(redirectUrl, {
      ...options,
      timeout: timeout - 1000,
      _redirectDepth: redirectDepth + 1,
    });
  }

  if (response.status >= 400) {
    throw new ApiError(
      `Сервер вернул ${response.status}`,
      "URL_FETCH_FAILED",
      response.status >= 500 ? 502 : 400,
    );
  }

  const finalUrl = response.url || url;
  const contentType = response.headers.get("content-type") ?? "text/html";
  const html = await readResponseWithLimit(response);

  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    parsed.hostname;

  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content");

  // Find main content area
  let mainEl = $("main").first();
  if (!mainEl.length) mainEl = $("article").first();
  if (!mainEl.length) mainEl = $("#main").first();
  if (!mainEl.length) mainEl = $("#content").first();
  if (!mainEl.length) mainEl = $("body");

  // Remove noisy elements from the selected content area
  mainEl
    .find(
      "nav, footer, aside, header, script, style, .navigation, .menu, .footer, .sidebar, .ads",
    )
    .remove();

  const mainHtml = mainEl.html() ?? "";
  const content = turndown.turndown(mainHtml);

  // Extract all links and make them absolute
  const linksSet = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, finalUrl).href;
      if (abs.startsWith("http://") || abs.startsWith("https://")) {
        linksSet.add(abs);
      }
    } catch {
      // ignore invalid hrefs
    }
  });

  return {
    url,
    finalUrl,
    title,
    content,
    links: Array.from(linksSet),
    metadata: {
      description,
      fetchedAt: new Date(),
      statusCode: response.status,
      contentType,
    },
  };
}
