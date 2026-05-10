import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

// TODO (security, deferred): expand IPv6 coverage when VPS supports IPv6
// - fc00::/7 Unique Local Addresses (private IPv6 ranges)
// - ff00::/8 multicast addresses
// - 2001:db8::/32 documentation prefix
// - DNS rebinding protection via custom HTTPS Agent with pinned IP
//
// Current state covers IPv4 (all private ranges + cloud metadata),
// IPv6 loopback (::1), IPv6 link-local (fe80::*), and IPv6-mapped IPv4
// (::ffff:x.x.x.x). Native IPv6 private ranges (fc00::/7) and DNS rebinding
// not blocked. Acceptable risk for current deployment (no IPv6 on Hostinger
// VPS by default; small private team usage). Re-evaluate when platform
// changes.

/**
 * Validates that a URL is safe to fetch (no SSRF).
 * Resolves DNS and checks the resulting IP against blocked ranges.
 * Only allows http: and https: protocols.
 */
export async function validateExternalUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Only HTTP/HTTPS
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Protocol not allowed: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();

  // Blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Hostname blocked: ${hostname}`);
  }

  // IPv6 loopback and link-local
  if (hostname === "[::1]" || hostname.startsWith("[fe80")) {
    throw new Error("IPv6 local address blocked");
  }

  // Resolve to IP and check
  let ip: string;
  if (isIP(hostname)) {
    ip = hostname;
  } else {
    try {
      const resolved = await lookup(hostname);
      ip = resolved.address;
    } catch {
      throw new Error(`DNS lookup failed for ${hostname}`);
    }
  }

  if (isIP(ip) === 4 && isBlockedIPv4(ip)) {
    throw new Error(`IP address blocked: ${ip}`);
  }

  // IPv6 mapped IPv4 check (::ffff:127.0.0.1)
  if (isIP(ip) === 6) {
    const v4match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4match && isBlockedIPv4(v4match[1]!)) {
      throw new Error(`IP address blocked: ${ip}`);
    }
  }

  return url;
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
