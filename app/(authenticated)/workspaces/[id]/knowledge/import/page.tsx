import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { listCategories } from "@/lib/services/kb/category.service";
import { listTags } from "@/lib/services/kb/tag.service";
import { ImportClient } from "./import-client";

type Props = { params: Promise<{ id: string }> };

export default async function ImportPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { id: workspaceId } = await params;

  const on = await isModuleEnabled(
    workspaceId,
    "knowledge",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${workspaceId}`);

  const [categories, tags] = await Promise.all([
    listCategories(workspaceId, session.user.id, session.user.role).catch(
      () => [],
    ),
    listTags(workspaceId, session.user.id, session.user.role).catch(() => []),
  ]);

  return (
    <ImportClient
      workspaceId={workspaceId}
      categories={categories}
      tags={tags}
    />
  );
}
