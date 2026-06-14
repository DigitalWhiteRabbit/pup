import "server-only";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { ApiError } from "@/lib/api-error";
import { safeFetch } from "./url-validator";

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
  const timeout = options?.timeout ?? 30000;
  const userAgent =
    options?.userAgent ??
    "PupKnowledgeBaseBot/1.0 (compatible; +https://pup.local)";

  // SSRF protection: DNS-pinned fetch with per-redirect-hop revalidation.
  // safeFetch resolves+pins+validates the host (and every redirect target),
  // so there is no DNS-rebind window and no unvalidated redirect.
  let result;
  try {
    result = await safeFetch(url, {
      timeoutMs: timeout,
      maxRedirects: 5,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (err: unknown) {
    const msg = (err as Error).message || "";
    if (msg.includes("aborted") || msg.includes("timeout")) {
      throw new ApiError("Превышено время ожидания", "URL_FETCH_TIMEOUT", 408);
    }
    // SSRF / validation rejections surface as 400, network failures as 502.
    if (
      msg.includes("blocked") ||
      msg.includes("Protocol not allowed") ||
      msg.includes("Invalid URL") ||
      msg.includes("redirects")
    ) {
      throw new ApiError(msg, "INVALID_URL", 400);
    }
    throw new ApiError(`Ошибка загрузки URL: ${msg}`, "URL_FETCH_FAILED", 502);
  }

  if (result.status >= 400) {
    throw new ApiError(
      `Сервер вернул ${result.status}`,
      "URL_FETCH_FAILED",
      result.status >= 500 ? 502 : 400,
    );
  }

  const finalUrl = result.finalUrl || url;
  const contentType = result.contentType || "text/html";
  const html = result.body;

  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    new URL(finalUrl).hostname;

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
      statusCode: result.status,
      contentType,
    },
  };
}
