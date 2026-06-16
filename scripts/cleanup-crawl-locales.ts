/**
 * Cleanup non-allowlisted locale articles created by a single KB crawl.
 *
 * A crawl of a multilingual site pulls every locale (/de /fr /tr /es …). We only
 * want RU + EN: the no-prefix root (= EN) and /ru (= Russian). This deletes
 * articles whose sourceUrl's first path segment is a valid ISO-639-1 language
 * code NOT in the allowlist. "No prefix" (e.g. /smartcycle-1) and /ru, /en are
 * kept.
 *
 * STRICTLY scoped: only articles linked to THIS crawl (via KbCrawlPage.articleId)
 * AND belonging to THIS workspace are ever touched.
 *
 * server-only deps → run with the react-server condition:
 *   pnpm exec tsx --conditions=react-server scripts/cleanup-crawl-locales.ts \
 *     --crawlId=<id> --workspaceId=<id> [--allow=ru,en] [--apply]
 *
 * Default is DRY-RUN (prints the locale distribution, deletes nothing).
 * Pass --apply to delete. Idempotent (a second --apply finds nothing to delete).
 * KbChunk rows cascade on KbArticle delete (onDelete: Cascade).
 */
import { db } from "../lib/db";
import { invalidateKbChunkCache } from "../lib/services/kb/vector-search.service";

// ISO 639-1 two-letter language codes (a path segment is treated as a locale
// ONLY if it is exactly one of these — so /ui, /io-section etc. are NOT locales).
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch " +
    "co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga " +
    "gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja " +
    "jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv " +
    "mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or " +
    "os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr " +
    "ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi " +
    "vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

function argValue(name: string, fallback = ""): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const APPLY = process.argv.includes("--apply");
const crawlId = argValue("crawlId");
const workspaceId = argValue("workspaceId");
const allow = new Set(
  argValue("allow", "ru,en")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** Locale = first path segment iff it is a valid ISO-639-1 code, else null. */
function localeOf(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    return null;
  }
  const seg = pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  const low = seg.toLowerCase();
  return /^[a-z]{2}$/.test(low) && ISO_639_1.has(low) ? low : null;
}

async function main(): Promise<void> {
  if (!crawlId || !workspaceId) {
    console.error(
      "Usage: --crawlId=<id> --workspaceId=<id> [--allow=ru,en] [--apply]",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `=== cleanup-crawl-locales — ${APPLY ? "APPLY (deletes)" : "DRY-RUN (no writes)"} ===`,
  );
  console.log(`crawlId=${crawlId} workspaceId=${workspaceId}`);
  console.log(
    `allowlist (kept locales): ${Array.from(allow).join(", ")} + no-prefix\n`,
  );

  // Articles produced by THIS crawl, restricted to THIS workspace (defense).
  const pages = await db.kbCrawlPage.findMany({
    where: { crawlId, articleId: { not: null } },
    select: { articleId: true },
  });
  const articleIds = Array.from(
    new Set(pages.map((p) => p.articleId!).filter(Boolean)),
  );

  const articles = await db.kbArticle.findMany({
    where: { id: { in: articleIds }, workspaceId, sourceType: "URL" },
    select: { id: true, sourceUrl: true, title: true },
  });

  // Classify
  const dist = new Map<string, number>();
  const toDelete: { id: string; sourceUrl: string | null }[] = [];
  let toKeep = 0;
  for (const a of articles) {
    const loc = localeOf(a.sourceUrl);
    const key = loc ?? "(no-prefix)";
    dist.set(key, (dist.get(key) ?? 0) + 1);
    if (loc !== null && !allow.has(loc)) {
      toDelete.push({ id: a.id, sourceUrl: a.sourceUrl });
    } else {
      toKeep++;
    }
  }

  // Report distribution
  console.log(`crawl-linked articles in workspace: ${articles.length}`);
  console.log(`(crawl pages with articleId: ${articleIds.length})\n`);
  console.log("locale         count   action");
  console.log("------------------------------");
  for (const [loc, count] of Array.from(dist.entries()).sort(
    (a, b) => b[1] - a[1],
  )) {
    const kept = loc === "(no-prefix)" || allow.has(loc);
    console.log(
      `${loc.padEnd(14)} ${String(count).padStart(5)}   ${kept ? "KEEP" : "DELETE"}`,
    );
  }
  console.log("------------------------------");
  console.log(`KEEP:   ${toKeep}`);
  console.log(`DELETE: ${toDelete.length}`);
  const delLocales = Array.from(
    new Set(toDelete.map((d) => localeOf(d.sourceUrl)).filter(Boolean)),
  ).sort();
  console.log(`locales to delete: ${delLocales.join(", ") || "(none)"}\n`);

  if (!APPLY) {
    console.log("(dry-run — nothing deleted; re-run with --apply to delete)");
    return;
  }

  if (toDelete.length === 0) {
    console.log("Nothing to delete. ✔");
    return;
  }

  // Delete in batches; KbChunk / tags / versions cascade on KbArticle delete.
  let deleted = 0;
  const ids = toDelete.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await db.kbArticle.deleteMany({
      where: { id: { in: batch }, workspaceId }, // workspace guard on delete too
    });
    deleted += res.count;
    console.log(`  deleted ${deleted}/${ids.length}`);
  }

  // Bust the per-workspace vector cache (server picks up via 60s TTL / restart).
  invalidateKbChunkCache(workspaceId);

  const remaining = await db.kbArticle.count({
    where: { id: { in: articleIds }, workspaceId },
  });
  console.log(
    `\nDeleted ${deleted} articles. Crawl articles remaining: ${remaining}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
