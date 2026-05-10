/**
 * Backfill searchText for existing KbArticle records.
 * Run: pnpm exec tsx scripts/backfill-search-text.ts
 */
import { PrismaClient } from "@prisma/client";

// Re-implement stripMarkdown + buildSearchText inline to avoid server-only import
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const db = new PrismaClient();

  const articles = await db.kbArticle.findMany({
    where: { searchText: null },
    select: { id: true, title: true, content: true },
  });

  console.log(`Found ${articles.length} articles without searchText`);

  for (const a of articles) {
    const searchText =
      a.title.toLowerCase() + " " + stripMarkdown(a.content).toLowerCase();
    await db.kbArticle.update({
      where: { id: a.id },
      data: { searchText, searchTextUpdatedAt: new Date() },
    });
  }

  console.log("Done");
  await db.$disconnect();
}

main().catch(console.error);
