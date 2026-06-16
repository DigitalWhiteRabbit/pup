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

// Leading "Back"/"Назад" line (plain text or a markdown link, optionally with a
// leading arrow glyph / list-quote marker) that some layouts emit above the body.
const LEADING_BACK_RE =
  /^[\s>#*-]*\[?\s*(?:←|⟵|<|»|«|→|⬅)?\s*(?:back|назад)\s*\]?(?:\([^)]*\))?\s*$/i;

/** Drop leading blank/"Back"/"Назад" lines that leak in above the article body. */
function stripLeadingChrome(markdown: string): string {
  const lines = markdown.split("\n");
  let i = 0;
  while (
    i < lines.length &&
    (lines[i]!.trim() === "" || LEADING_BACK_RE.test(lines[i]!.trim()))
  ) {
    i++;
  }
  return lines.slice(i).join("\n").trim();
}

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

  // Find main content area. Prefer the NARROWEST article-body container first
  // (WordPress/Elementor sites often have no semantic <main>, and their
  // <article>/<main> still wraps chrome like a leading "Back" link). Falling
  // back progressively to broader containers, then <body>.
  const CONTENT_SELECTORS = [
    ".article-post__content", // atlas-system.io (custom WP theme) article body
    ".entry-content",
    ".post-content",
    ".elementor-widget-theme-post-content",
    "main",
    "article",
    "#main",
    "#content",
  ];
  let mainEl = $("body").first();
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length) {
      mainEl = el as typeof mainEl;
      break;
    }
  }

  // Remove noisy elements from the selected content area
  mainEl
    .find(
      "nav, footer, aside, header, script, style, .navigation, .menu, .footer, .sidebar, .ads",
    )
    .remove();

  // Defense-in-depth sanitization of the UNTRUSTED page HTML BEFORE Turndown.
  // Turndown keeps unknown/inline tags as raw HTML, so a malicious page could
  // smuggle <img onerror=…>, <iframe>, or javascript:/data: links into the
  // imported markdown. Strip executable surfaces here; the render layer
  // (MarkdownPreview → rehype-sanitize) is the primary guard.
  mainEl
    .find(
      "iframe, object, embed, form, svg, math, link, meta, base, script, style",
    )
    .remove();
  mainEl.find("*").each((_, el) => {
    if (!("attribs" in el) || !el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      const lower = name.toLowerCase();
      // Drop all inline event handlers (onclick, onerror, onload, …).
      if (lower.startsWith("on")) {
        $(el).removeAttr(name);
        continue;
      }
      // Drop dangerous URL schemes on href/src/xlink:href.
      if (lower === "href" || lower === "src" || lower === "xlink:href") {
        const v = el.attribs[name]?.replace(/\s+/g, "").toLowerCase() ?? "";
        if (
          v.startsWith("javascript:") ||
          v.startsWith("data:") ||
          v.startsWith("vbscript:")
        ) {
          $(el).removeAttr(name);
        }
      }
    }
  });

  // Strip page chrome that leaks into the body on non-semantic WP layouts:
  // nav/banner/contentinfo regions, breadcrumbs, and back links by role/aria.
  mainEl
    .find(
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
        '[class*="breadcrumb" i], [aria-label*="back" i], [aria-label*="назад" i]',
    )
    .remove();

  // Remove image-only anchors (header/footer logo bars & grids): an <a> whose
  // only visible content is an <img> (no text). This kills the atlas-system
  // logo grid (a.home-project__item > img) without touching real body links.
  mainEl.find("a").each((_, el) => {
    const $a = $(el);
    if ($a.text().replace(/\s+/g, "") === "" && $a.find("img").length > 0) {
      $a.remove();
    }
  });

  const mainHtml = mainEl.html() ?? "";
  const content = stripLeadingChrome(turndown.turndown(mainHtml));

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
