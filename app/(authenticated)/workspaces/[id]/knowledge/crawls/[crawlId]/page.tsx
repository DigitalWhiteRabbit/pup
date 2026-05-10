import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getCrawlStatus } from "@/lib/services/kb/crawler.service";
import { CrawlProgressClient } from "./crawl-progress-client";

type Props = { params: Promise<{ id: string; crawlId: string }> };

export default async function CrawlProgressPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { id: workspaceId, crawlId } = await params;

  const crawl = await getCrawlStatus(
    crawlId,
    session.user.id,
    session.user.role,
  ).catch(() => null);

  if (!crawl) redirect(`/workspaces/${workspaceId}/knowledge`);

  return <CrawlProgressClient initialCrawl={crawl} workspaceId={workspaceId} />;
}
