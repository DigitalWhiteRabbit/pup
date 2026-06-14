import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SSRF hardening (P0): DNS-pinned fetch + full internal-range blocklist.
// Covers url-validator (isBlockedIp / resolveAndPin / safeFetch) and the shared
// kb fetcher parseUrl (which backs crawl + import). link-preview, the
// external-users proxy and the connection-test all call the SAME safeFetch, so
// the safeFetch suite is their security contract too.

vi.mock("server-only", () => ({}));

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  isBlockedIp,
  resolveAndPin,
  safeFetch,
} from "@/lib/services/kb/url-validator";
import { parseUrl } from "@/lib/services/kb/url-parser.service";

const PUBLIC_V4 = "93.184.216.34"; // example.com — public
function publicLookup() {
  lookupMock.mockResolvedValue([{ address: PUBLIC_V4, family: 4 }]);
}

beforeEach(() => {
  lookupMock.mockReset();
});

describe("isBlockedIp — internal ranges blocked, public allowed", () => {
  it.each([
    ["127.0.0.1", true], // loopback
    ["127.255.255.255", true],
    ["10.0.0.5", true], // private
    ["172.16.0.1", true], // private /12 start
    ["172.31.255.255", true], // private /12 end
    ["172.32.0.1", false], // just outside /12
    ["192.168.1.1", true], // private
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true], // CGNAT
    ["0.0.0.0", true], // reserved
    ["8.8.8.8", false], // public
    ["1.1.1.1", false], // public
    [PUBLIC_V4, false], // public
  ])("IPv4 %s → blocked=%s", (ip, blocked) => {
    expect(isBlockedIp(ip as string)).toBe(blocked);
  });

  it.each([
    ["::1", true], // loopback
    ["::", true], // unspecified
    ["fe80::1", true], // link-local fe80::/10
    ["fe90::1", true], // link-local (mid /10 — string-prefix "fe80" missed this)
    ["febf::1", true], // link-local (top of /10)
    ["fec0::1", false], // just past link-local /10 (site-local, deprecated, public-ish)
    ["fc00::1", true], // ULA fc00::/7
    ["fd12:3456::1", true], // ULA fd..
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback (dotted)
    ["::ffff:169.254.169.254", true], // IPv4-mapped metadata (dotted)
    // Hex-notation IPv4-mapped — must be caught too (regression: dotted-only
    // regex let these through, re-opening SSRF to loopback/metadata).
    ["::ffff:7f00:1", true], // = 127.0.0.1
    ["::ffff:a9fe:a9fe", true], // = 169.254.169.254 (cloud metadata)
    ["::ffff:a00:1", true], // = 10.0.0.1
    ["::ffff:c0a8:1", true], // = 192.168.0.1
    ["0:0:0:0:0:ffff:7f00:1", true], // = 127.0.0.1 (full form)
    ["::a9fe:a9fe", true], // IPv4-compatible = 169.254.169.254
    ["64:ff9b::a00:1", true], // NAT64 well-known prefix embedding 10.0.0.1
    ["::ffff:808:808", false], // = 8.8.8.8 (public, mapped) — not blocked
    ["2606:4700:4700::1111", false], // public (Cloudflare)
    ["2001:4860:4860::8888", false], // public (Google)
  ])("IPv6 %s → blocked=%s", (ip, blocked) => {
    expect(isBlockedIp(ip as string)).toBe(blocked);
  });

  it("garbage / non-IP literal → blocked", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("resolveAndPin — validate + pin, reject internal & rebind", () => {
  it("public host → resolves and pins the public IP", async () => {
    publicLookup();
    const { url, pinned } = await resolveAndPin("https://example.com/page");
    expect(url.hostname).toBe("example.com");
    expect(pinned.address).toBe(PUBLIC_V4);
    expect(pinned.family).toBe(4);
  });

  it("literal internal IP → blocked (no DNS needed)", async () => {
    await expect(
      resolveAndPin("http://169.254.169.254/latest/"),
    ).rejects.toThrow(/blocked/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("DNS-rebind: host resolves to loopback → blocked", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolveAndPin("https://evil.example/")).rejects.toThrow(
      /blocked/i,
    );
  });

  it("mixed answer (public + internal) → blocked (ALL addresses validated)", async () => {
    lookupMock.mockResolvedValue([
      { address: PUBLIC_V4, family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(resolveAndPin("https://evil.example/")).rejects.toThrow(
      /blocked/i,
    );
  });

  it("non-http(s) protocol → rejected", async () => {
    await expect(resolveAndPin("ftp://example.com/")).rejects.toThrow(
      /Protocol not allowed/,
    );
    await expect(resolveAndPin("file:///etc/passwd")).rejects.toThrow(
      /Protocol not allowed/,
    );
  });

  it("blocked hostname (localhost) → rejected", async () => {
    await expect(resolveAndPin("http://localhost/")).rejects.toThrow(
      /blocked/i,
    );
  });
});

describe("safeFetch — DNS-pinned fetch with per-hop redirect revalidation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("legit public URL → fetches and returns body", async () => {
    publicLookup();
    fetchMock.mockResolvedValue(
      new Response("<html><title>ok</title></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await safeFetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // pinned via dispatcher, manual redirect mode
    const opts = fetchMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.redirect).toBe("manual");
    expect(opts.dispatcher).toBeDefined();
  });

  it("direct internal IP → blocked before any fetch", async () => {
    await expect(safeFetch("http://127.0.0.1:8080/")).rejects.toThrow(
      /blocked/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("metadata endpoint → blocked before any fetch", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hex IPv4-mapped IPv6 literal (metadata) → blocked before any fetch", async () => {
    await expect(
      safeFetch("http://[::ffff:a9fe:a9fe]/latest/meta-data/"),
    ).rejects.toThrow(/blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirect to internal IP → blocked on the redirect hop", async () => {
    publicLookup();
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
    );
    await expect(safeFetch("https://example.com/")).rejects.toThrow(/blocked/i);
    // first hop fetched, redirect target rejected (never fetched)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redirect to another public URL → followed", async () => {
    publicLookup();
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://example.com/final" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("final", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    const res = await safeFetch("https://example.com/start");
    expect(res.status).toBe(200);
    expect(res.body).toBe("final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("too many redirects → throws", async () => {
    publicLookup();
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    );
    await expect(
      safeFetch("https://example.com/", { maxRedirects: 2 }),
    ).rejects.toThrow(/redirects/i);
  });

  it("readBody:false → status probe, body not read", async () => {
    publicLookup();
    fetchMock.mockResolvedValue(new Response("secret-body", { status: 200 }));
    const res = await safeFetch("https://example.com/", { readBody: false });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });
});

describe("parseUrl (kb crawl + import shared fetcher) — SSRF propagation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("rebind to internal → ApiError 400 (INVALID_URL), no content fetched", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(parseUrl("https://evil.example/")).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("direct metadata IP → ApiError 400", async () => {
    await expect(
      parseUrl("http://169.254.169.254/latest/"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("legit public page → parsed content returned", async () => {
    publicLookup();
    fetchMock.mockResolvedValue(
      new Response(
        "<html><head><title>Hello</title></head><body><main>World</main></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
    const result = await parseUrl("https://example.com/page");
    expect(result.title).toBe("Hello");
    expect(result.content).toContain("World");
    expect(result.metadata.statusCode).toBe(200);
  });
});
