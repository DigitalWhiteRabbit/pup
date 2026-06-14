import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

// ─── SSRF blocklist ─────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata",
]);

const BLOCKED_IP_RANGES: Array<{ start: number; end: number }> = [
  // Loopback 127.0.0.0/8
  { start: ip4ToNum("127.0.0.0"), end: ip4ToNum("127.255.255.255") },
  // Private 10.0.0.0/8
  { start: ip4ToNum("10.0.0.0"), end: ip4ToNum("10.255.255.255") },
  // Private 172.16.0.0/12
  { start: ip4ToNum("172.16.0.0"), end: ip4ToNum("172.31.255.255") },
  // Private 192.168.0.0/16
  { start: ip4ToNum("192.168.0.0"), end: ip4ToNum("192.168.255.255") },
  // Link-local + cloud metadata 169.254.0.0/16
  { start: ip4ToNum("169.254.0.0"), end: ip4ToNum("169.254.255.255") },
  // CGNAT 100.64.0.0/10
  { start: ip4ToNum("100.64.0.0"), end: ip4ToNum("100.127.255.255") },
  // Reserved 0.0.0.0/8
  { start: ip4ToNum("0.0.0.0"), end: ip4ToNum("0.255.255.255") },
];

function ip4ToNum(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => acc * 256 + parseInt(octet, 10), 0);
}

function isBlockedIPv4(ip: string): boolean {
  const num = ip4ToNum(ip);
  return BLOCKED_IP_RANGES.some((r) => num >= r.start && num <= r.end);
}

/**
 * Expand an IPv6 literal (any RFC 5952 form, incl. "::" compression and a
 * trailing dotted-quad) to its 8 hextets, or null if unparseable. Used so we
 * can decode IPv4-mapped/compatible addresses regardless of notation
 * (dotted `::ffff:127.0.0.1` AND hex `::ffff:7f00:1` resolve identically).
 */
function expandIPv6(ip: string): number[] | null {
  let s = ip;
  // Trailing embedded dotted-quad → convert to two hextets.
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = dotted[2]!.split(".").map(Number);
    if (v4.some((o) => o > 255)) return null;
    const h1 = ((v4[0]! << 8) | v4[1]!).toString(16);
    const h2 = ((v4[2]! << 8) | v4[3]!).toString(16);
    s = `${dotted[1]}${h1}:${h2}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  let full: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    full = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    full = head;
  }
  if (full.length !== 8) return null;
  const nums = full.map((h) => parseInt(h || "0", 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/**
 * True if an already-resolved IP literal is in any internal / blocked range.
 * Covers IPv4 (all private + loopback + link-local/metadata + CGNAT + reserved)
 * and IPv6 (loopback ::1, unspecified ::, link-local fe80::/10, ULA fc00::/7,
 * and IPv4-mapped / IPv4-compatible forms that embed an internal v4 address,
 * in BOTH dotted and hex notations).
 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIPv4(ip);
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    // Decode to 8 hextets so range checks use real bits, not string prefixes.
    const hextets = expandIPv6(low);
    if (!hextets) return true; // valid-per-isIP but unparseable → fail closed
    if ((hextets[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((hextets[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    // IPv4-mapped (::ffff:0:0/96) / IPv4-compatible (::/96) / NAT64
    // (64:ff9b::/96): decode the embedded v4 from the last 32 bits — works for
    // dotted AND hex notation.
    const isMapped =
      hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
    const isCompat = hextets.slice(0, 6).every((h) => h === 0);
    const isNat64 =
      hextets[0] === 0x64 &&
      hextets[1] === 0xff9b &&
      hextets.slice(2, 6).every((h) => h === 0);
    if (isMapped || isCompat || isNat64) {
      const v4 = `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${
        hextets[7]! >> 8
      }.${hextets[7]! & 0xff}`;
      if (isBlockedIPv4(v4)) return true;
    }
    return false;
  }
  return true; // not a valid IP literal → treat as blocked
}

// ─── Resolve + validate (returns a PINNED address) ──────────────────────────

type Pinned = { hostname: string; address: string; family: 4 | 6 };

/**
 * Validate a URL and resolve its host to a single PINNED IP guaranteed not to
 * be internal. DNS is resolved ONCE here; the pinned IP is then forced onto the
 * connection (see safeFetch) so a DNS-rebind cannot swap it between check and
 * connect. ALL resolved addresses are validated — a host returning one public
 * and one internal address is rejected. Catches decimal/hex/octal-encoded host
 * forms too, since the OS resolver normalizes them before we inspect the IP.
 */
export async function resolveAndPin(rawUrl: string): Promise<{
  url: URL;
  pinned: Pinned;
}> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Protocol not allowed: ${url.protocol}`);
  }

  // url.hostname keeps IPv6 in brackets; strip them for inspection.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Hostname blocked: ${hostname}`);
  }

  // IP literal → validate directly and pin it.
  const literalFam = isIP(hostname);
  if (literalFam) {
    if (isBlockedIp(hostname)) {
      throw new Error(`IP address blocked: ${hostname}`);
    }
    return {
      url,
      pinned: { hostname, address: hostname, family: literalFam === 6 ? 6 : 4 },
    };
  }

  // Hostname → resolve ALL addresses, validate every one, pin the first.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS lookup failed for ${hostname}`);
  }
  if (addrs.length === 0) throw new Error(`DNS lookup failed for ${hostname}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`Resolved to blocked IP: ${a.address}`);
    }
  }
  const first = addrs[0]!;
  return {
    url,
    pinned: {
      hostname,
      address: first.address,
      family: first.family === 6 ? 6 : 4,
    },
  };
}

/**
 * Back-compat validator (no fetch). Now also blocks IPv6 ULA (fc00::/7) and
 * validates ALL resolved addresses. Prefer safeFetch for anything that makes a
 * request — it closes the TOCTOU/DNS-rebind window that this alone cannot.
 */
export async function validateExternalUrl(rawUrl: string): Promise<URL> {
  const { url } = await resolveAndPin(rawUrl);
  return url;
}

// ─── Hardened fetch (DNS-pinned, redirect-validated) ────────────────────────

export type SafeFetchResult = {
  status: number;
  headers: Headers;
  finalUrl: string;
  contentType: string;
  body: string;
};

export type SafeFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** When false the body is not read (status-probe only, e.g. connection test). */
  readBody?: boolean;
};

/**
 * SSRF-safe fetch. Resolves + validates the host, PINS the connection to the
 * validated IP (custom undici lookup → no DNS-rebind window between check and
 * connect), follows redirects manually re-validating + re-pinning EACH hop,
 * and enforces a body-size cap + timeout. Only http/https. Use this for ALL
 * server-side fetches of user/DB-supplied URLs.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 30000;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, pinned } = await resolveAndPin(currentUrl);

    // Pin: force the socket to the validated IP regardless of any re-resolution.
    // SNI / Host header stay = hostname (TLS cert validation still works).
    const agent = new Agent({
      connect: {
        lookup: (
          _hostname: string,
          options: { all?: boolean } | undefined,
          cb: (
            err: NodeJS.ErrnoException | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void,
        ) => {
          if (options && options.all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        redirect: "manual",
        signal: controller.signal,
        // @ts-expect-error Node's global fetch honors the undici dispatcher option
        dispatcher: agent,
      });
    } catch (err) {
      void agent.close();
      throw new Error(`Fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect: re-validate + re-pin on the next loop iteration.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      void agent.close();
      if (!location) throw new Error("Redirect without Location header");
      currentUrl = new URL(location, url).href;
      continue;
    }

    let body = "";
    try {
      if (opts.readBody !== false) {
        body = await readResponseWithLimit(response, maxBytes);
      } else {
        await response.body?.cancel();
      }
    } finally {
      void agent.close();
    }

    return {
      status: response.status,
      headers: response.headers,
      finalUrl: response.url || url.href,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  }

  throw new Error("Too many redirects");
}

/** Max response body size for URL fetch (10 MB) */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Reads response body with a size limit. Throws if the body exceeds maxBytes.
 */
export async function readResponseWithLimit(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  // Check Content-Length header first
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(
      `Response too large: ${contentLength} bytes (max ${maxBytes})`,
    );
  }

  // Stream with limit
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const decoder = new TextDecoder();
  return (
    chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
    decoder.decode()
  );
}
