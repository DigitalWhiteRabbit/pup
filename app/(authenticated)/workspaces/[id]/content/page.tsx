import { auth } from "@/lib/auth";
import {
  getWorkspaceById,
  isModuleEnabled,
} from "@/lib/services/workspace.service";
import { resolveContentAccess } from "@/lib/services/content.service";
import { redirect } from "next/navigation";
import { ContentShell } from "./content-shell";

export const metadata = { title: "Контент-план | ПУП" };

type Props = { params: { id: string } };

export default async function ContentPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  let workspace;
  try {
    workspace = await getWorkspaceById(
      params.id,
      session.user.id,
      session.user.role,
    );
  } catch {
    redirect("/workspaces");
  }

  const moduleOn = await isModuleEnabled(
    params.id,
    "content",
    session.user.id,
    session.user.role,
  );
  if (!moduleOn) redirect(`/workspaces/${params.id}`);

  let isModerator = false;
  try {
    ({ isModerator } = await resolveContentAccess(
      params.id,
      session.user.id,
      session.user.role,
    ));
  } catch {
    redirect(`/workspaces/${params.id}`);
  }

  const members = workspace.members.map((m) => ({ id: m.id, login: m.login }));

  return (
    <ContentShell
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      isModerator={isModerator}
      currentUserId={session.user.id}
      members={members}
    />
  );
}
