/**
 * KB exact-duplicate audit + cleanup (workspace-scoped). Clusters articles that
 * share the same normalizedUrl OR the same contentHash. DRY-RUN by default
 * (prints clusters, deletes nothing). --apply keeps the CANONICAL article per
 * cluster and deletes the rest (KbChunk/tags/versions cascade).
 *
 * Canonical rule: prefer an article that has a category or tags; tie-break by
 * earliest createdAt. (Keeps the most "curated"/original copy.)
 *
 *   pnpm exec tsx --conditions=react-server scripts/kb-dedup-audit.ts \
 *     [--workspaceId=<id>] [--apply]
 *
 * Without --workspaceId, audits every workspace. NEVER compares across
 * workspaces (clustering is per workspace).
 */
import { db } from "../lib/db";
import { invalidateKbChunkCache } from "../lib/services/kb/vector-search.service";

const APPLY = process.argv.includes("--apply");
function argValue(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}
const onlyWs = argValue("workspaceId");

type Row = {
  id: string;
  title: string;
  sourceUrl: string | null;
  createdAt: Date;
  categoryId: string | null;
  normalizedUrl: string | null;
  contentHash: string | null;
  _count: { chunks: number; tags: number };
};

// Union-find over article ids.
class UF {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function canonicalOf(rows: Row[]): Row {
  // prefer category/tags, then earliest createdAt
  return [...rows].sort((a, b) => {
    const ac = a.categoryId || a._count.tags > 0 ? 0 : 1;
    const bc = b.categoryId || b._count.tags > 0 ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0]!;
}

async function auditWorkspace(
  workspaceId: string,
): Promise<{ deleted: number }> {
  const rows = (await db.kbArticle.findMany({
    where: { workspaceId },
    select: {
      id: true,
      title: true,
      sourceUrl: true,
      createdAt: true,
      categoryId: true,
      normalizedUrl: true,
      contentHash: true,
      _count: { select: { chunks: true, tags: true } },
    },
  })) as Row[];

  // Link rows that share a normalizedUrl or contentHash.
  const uf = new UF();
  const byUrl = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const r of rows) {
    uf.find(r.id);
    if (r.normalizedUrl) {
      const prev = byUrl.get(r.normalizedUrl);
      if (prev) uf.union(prev, r.id);
      else byUrl.set(r.normalizedUrl, r.id);
    }
    if (r.contentHash) {
      const prev = byHash.get(r.contentHash);
      if (prev) uf.union(prev, r.id);
      else byHash.set(r.contentHash, r.id);
    }
  }

  const clusters = new Map<string, Row[]>();
  for (const r of rows) {
    const root = uf.find(r.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(r);
  }
  const dupClusters = Array.from(clusters.values()).filter((c) => c.length > 1);

  if (dupClusters.length === 0) return { deleted: 0 };

  console.log(
    `\n### workspace ${workspaceId}: ${dupClusters.length} duplicate cluster(s)`,
  );
  let toDeleteTotal = 0;
  const idsToDelete: string[] = [];
  for (const cluster of dupClusters) {
    const canon = canonicalOf(cluster);
    console.log(`  cluster (${cluster.length}):`);
    for (const r of cluster) {
      const mark = r.id === canon.id ? "KEEP " : "DEL  ";
      console.log(
        `    ${mark} ${r.id}  "${r.title}"  ${r.sourceUrl ?? "-"}  chunks=${r._count.chunks} tags=${r._count.tags} cat=${r.categoryId ? "y" : "n"}  ${r.createdAt.toISOString().slice(0, 10)}`,
      );
      if (r.id !== canon.id) {
        idsToDelete.push(r.id);
        toDeleteTotal++;
      }
    }
  }

  if (APPLY && idsToDelete.length) {
    for (let i = 0; i < idsToDelete.length; i += 100) {
      const batch = idsToDelete.slice(i, i + 100);
      await db.kbArticle.deleteMany({
        where: { id: { in: batch }, workspaceId },
      });
    }
    invalidateKbChunkCache(workspaceId);
  }
  return { deleted: toDeleteTotal };
}

async function main(): Promise<void> {
  console.log(
    `=== kb-dedup-audit — ${APPLY ? "APPLY (deletes)" : "DRY-RUN"} ===`,
  );
  console.log(
    "canonical rule: has category/tags first, then earliest createdAt\n",
  );

  let workspaceIds: string[];
  if (onlyWs) {
    workspaceIds = [onlyWs];
  } else {
    const wss = await db.workspace.findMany({ select: { id: true } });
    workspaceIds = wss.map((w) => w.id);
  }

  let grandDeleted = 0;
  for (const ws of workspaceIds) {
    const { deleted } = await auditWorkspace(ws);
    grandDeleted += deleted;
  }

  console.log(
    `\n=== TOTAL duplicates ${APPLY ? "deleted" : "to delete"}: ${grandDeleted} across ${workspaceIds.length} workspace(s) ===`,
  );
  if (!APPLY && grandDeleted > 0)
    console.log("(dry-run — re-run with --apply to delete)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
