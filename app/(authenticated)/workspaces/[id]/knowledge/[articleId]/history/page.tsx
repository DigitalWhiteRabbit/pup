import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getArticleById } from "@/lib/services/kb/article.service";
import { getArticleHistory } from "@/lib/services/kb/article.service";
import { HistoryClient } from "./history-client";

type Props = { params: { id: string; articleId: string } };

export default async function HistoryPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [article, history] = await Promise.all([
    getArticleById(params.articleId, session.user.id, session.user.role).catch(
      () => null,
    ),
    getArticleHistory(
      params.articleId,
      session.user.id,
      session.user.role,
    ).catch(() => []),
  ]);

  if (!article) redirect(`/workspaces/${params.id}/knowledge`);

  return (
    <HistoryClient
      article={article}
      history={history}
      workspaceId={params.id}
    />
  );
}
