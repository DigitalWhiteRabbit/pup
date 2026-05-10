import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { listCategories } from "@/lib/services/kb/category.service";
import { listTags } from "@/lib/services/kb/tag.service";
import { SearchClient } from "./search-client";

type Props = { params: { id: string } };

export default async function KbSearchPage({ params }: Props) {
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

  const [categories, tags] = await Promise.all([
    listCategories(params.id, session.user.id, session.user.role).catch(
      () => [],
    ),
    listTags(params.id, session.user.id, session.user.role).catch(() => []),
  ]);

  return (
    <SearchClient workspaceId={params.id} categories={categories} tags={tags} />
  );
}
