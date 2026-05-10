import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getArticleById } from "@/lib/services/kb/article.service";
import { ArticleViewClient } from "./article-view-client";

type Props = { params: { id: string; articleId: string } };

export default async function ArticlePage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const article = await getArticleById(
    params.articleId,
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect(`/workspaces/${params.id}/knowledge`);
  });
  if (!article) redirect(`/workspaces/${params.id}/knowledge`);

  return <ArticleViewClient article={article} workspaceId={params.id} />;
}
