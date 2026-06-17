import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/**
 * KB exact-duplicate detection (workspace-scoped). Two articles are exact
 * duplicates iff they share the same normalized sourceUrl OR the same content
 * hash. Different-language versions have different text → different hash → NOT
 * duplicates. Dedup NEVER compares across workspaces.
 */

const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "ref",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

/**
 * Canonicalize a URL for dedup: lowercase host/protocol, drop fragment, drop
 * trailing slash, strip tracking params (utm_*, gclid, fbclid, ref, …), sort
 * remaining params. Returns null for empty/invalid input.
 */
export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url || !String(url).trim()) return null;
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  u.hash = "";
  u.protocol = u.protocol.toLowerCase();
  u.host = u.host.toLowerCase();
  // Strip tracking params (utm_* prefix or known set).
  const toDelete: string[] = [];
  u.searchParams.forEach((_v, k) => {
    const lk = k.toLowerCase();
    if (lk.startsWith("utm_") || TRACKING_PARAMS.has(lk)) toDelete.push(k);
  });
  for (const k of toDelete) u.searchParams.delete(k);
  u.searchParams.sort();
  // Drop trailing slash (except root path).
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/**
 * sha256 of content with whitespace normalized (collapse runs to a single space
 * + trim) so trivial formatting differences don't defeat exact-dup detection.
 * Returns null for empty input.
 */
export function computeContentHash(
  text: string | null | undefined,
): string | null {
  if (text == null) return null;
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export type DuplicateMatch = {
  /** "url" = same normalized source URL; "content" = same content hash. */
  match: "url" | "content";
  article: { id: string; title: string; sourceUrl: string | null };
};

/**
 * Find an existing exact-duplicate article in the SAME workspace. URL match
 * takes priority over content match. `excludeId` skips the article itself
 * (e.g. when updating). Returns null when no duplicate exists.
 */
export async function findDuplicate(
  workspaceId: string,
  opts: {
    normalizedUrl?: string | null;
    contentHash?: string | null;
    excludeId?: string;
  },
): Promise<DuplicateMatch | null> {
  if (!workspaceId) return null;
  const notSelf = opts.excludeId ? { id: { not: opts.excludeId } } : {};

  if (opts.normalizedUrl) {
    const byUrl = await db.kbArticle.findFirst({
      where: { workspaceId, normalizedUrl: opts.normalizedUrl, ...notSelf },
      select: { id: true, title: true, sourceUrl: true },
      orderBy: { createdAt: "asc" },
    });
    if (byUrl) return { match: "url", article: byUrl };
  }

  if (opts.contentHash) {
    const byHash = await db.kbArticle.findFirst({
      where: { workspaceId, contentHash: opts.contentHash, ...notSelf },
      select: { id: true, title: true, sourceUrl: true },
      orderBy: { createdAt: "asc" },
    });
    if (byHash) return { match: "content", article: byHash };
  }

  return null;
}
