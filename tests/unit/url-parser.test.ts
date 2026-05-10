import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/services/kb/url-validator", () => ({
  validateExternalUrl: async (rawUrl: string) => new URL(rawUrl),
  readResponseWithLimit: async (response: unknown) =>
    (response as { text: () => Promise<string> }).text(),
  MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
}));
vi.mock("@/lib/api-error", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

function mockFetch(html: string, status = 200, finalUrl?: string) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    url: finalUrl ?? "https://example.com/",
    headers: { get: () => "text/html; charset=utf-8" },
    text: () => Promise.resolve(html),
  } as unknown as Response);
}

describe("parseUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts title from <title> tag", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        "<html><head><title>My Page</title></head><body><main>Content</main></body></html>",
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/");
    expect(result.title).toBe("My Page");
  });

  it("falls back to <h1> if no <title>", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        "<html><head></head><body><h1>Main Heading</h1><main>text</main></body></html>",
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/");
    expect(result.title).toBe("Main Heading");
  });

  it("converts main HTML to Markdown", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        "<html><head><title>T</title></head><body><main><h2>Hello</h2><p>World</p></main></body></html>",
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
  });

  it("removes nav/footer/script/style elements", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        `<html><head><title>T</title></head><body>
          <nav>NAV_CONTENT</nav>
          <footer>FOOTER_CONTENT</footer>
          <script>SCRIPT_CONTENT</script>
          <style>STYLE_CONTENT</style>
          <main><p>Real Content</p></main>
        </body></html>`,
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/");
    expect(result.content).not.toContain("NAV_CONTENT");
    expect(result.content).not.toContain("FOOTER_CONTENT");
    expect(result.content).not.toContain("SCRIPT_CONTENT");
    expect(result.content).toContain("Real Content");
  });

  it("extracts all absolute links from page", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        `<html><head><title>T</title></head><body>
          <a href="/page1">one</a>
          <a href="https://other.com/page2">two</a>
          <a href="not-a-url-at-all">three</a>
          <main>x</main>
        </body></html>`,
        200,
        "https://example.com/",
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/");
    expect(result.links).toContain("https://example.com/page1");
    expect(result.links).toContain("https://other.com/page2");
  });

  it("throws ApiError on 4xx response", async () => {
    vi.stubGlobal("fetch", mockFetch("Not Found", 404));
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(parseUrl("https://example.com/")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("throws ApiError on 5xx response", async () => {
    vi.stubGlobal("fetch", mockFetch("Server Error", 500));
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(parseUrl("https://example.com/")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("throws ApiError on invalid URL", async () => {
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(parseUrl("not-a-url")).rejects.toBeInstanceOf(ApiError);
  });

  it("returns finalUrl from response.url (after redirects)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        "<html><head><title>T</title></head><body><main>x</main></body></html>",
        200,
        "https://example.com/redirected",
      ),
    );
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const result = await parseUrl("https://example.com/original");
    expect(result.finalUrl).toBe("https://example.com/redirected");
  });

  it("throws ApiError on network timeout (AbortError)", async () => {
    const abortErr = new Error("AbortError");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    const { parseUrl } = await import("@/lib/services/kb/url-parser.service");
    const { ApiError } = await import("@/lib/api-error");
    await expect(
      parseUrl("https://example.com/", { timeout: 1 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
