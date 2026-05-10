import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getArticleById } from "@/lib/services/kb/article.service";
import { listCategories } from "@/lib/services/kb/category.service";
import { listTags } from "@/lib/services/kb/tag.service";
import { EditArticleClient } from "./edit-article-client";

type Props = { params: { id: string; articleId: string } };

export default async function EditArticlePage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const [article, categories, tags] = await Promise.all([
    getArticleById(params.articleId, session.user.id, session.user.role).catch(
      () => null,
    ),
    listCategories(params.id, session.user.id, session.user.role).catch(
      () => [],
    ),
    listTags(params.id, session.user.id, session.user.role).catch(() => []),
  ]);

  if (!article) redirect(`/workspaces/${params.id}/knowledge`);

  return (
    <EditArticleClient
      article={article}
      workspaceId={params.id}
      categories={categories}
      tags={tags}
    />
  );
}
