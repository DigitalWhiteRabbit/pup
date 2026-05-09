import { auth } from "@/lib/auth";
import {
  getWorkspaceById,
  getAllModules,
} from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { WorkspaceOverviewClient } from "./workspace-overview-client";

type Props = { params: { id: string } };

export default async function WorkspaceOverviewPage({ params }: Props) {
  const session = await auth();

  let workspace;
  let modules;
  try {
    workspace = await getWorkspaceById(
      params.id,
      session!.user.id,
      session!.user.role,
    );
    modules = await getAllModules(
      params.id,
      session!.user.id,
      session!.user.role,
    );
  } catch {
    redirect("/workspaces");
  }

  const isOwner =
    session!.user.role === "ADMIN" ||
    workspace.members.some(
      (m) => m.id === session!.user.id && m.role === "OWNER",
    );

  return (
    <WorkspaceOverviewClient
      workspace={workspace}
      modules={modules}
      isOwner={isOwner}
      currentUserId={session!.user.id}
    />
  );
}
