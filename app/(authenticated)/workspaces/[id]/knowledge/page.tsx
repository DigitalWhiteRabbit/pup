import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { listArticles } from "@/lib/services/kb/article.service";
import { listCategories } from "@/lib/services/kb/category.service";
import { listTags } from "@/lib/services/kb/tag.service";
import { KnowledgeClient } from "./knowledge-client";

export const metadata = { title: "База знаний | ПУП" };

type Props = { params: { id: string } };

export default async function KnowledgePage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const on = await isModuleEnabled(
    params.id,
    "knowledge",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  const [articlesResult, categories, tags] = await Promise.all([
    listArticles(params.id, session.user.id, session.user.role, {
      page: 1,
      pageSize: 20,
      isPublished: true,
    }).catch(() => ({ data: [], total: 0 })),
    listCategories(params.id, session.user.id, session.user.role).catch(
      () => [],
    ),
    listTags(params.id, session.user.id, session.user.role).catch(() => []),
  ]);

  return (
    <KnowledgeClient
      workspaceId={params.id}
      initialArticles={articlesResult.data}
      initialTotal={articlesResult.total}
      categories={categories}
      tags={tags}
    />
  );
}
