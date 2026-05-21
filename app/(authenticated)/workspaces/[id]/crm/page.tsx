import { auth } from "@/lib/auth";
import {
  getWorkspaceById,
  isModuleEnabled,
} from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { WorkspaceBoardShell } from "./workspace-board-shell";

export const metadata = { title: "CRM | ПУП" };

type Props = { params: { id: string } };

export default async function CrmPage({ params }: Props) {
  const session = await auth();

  let workspace;
  try {
    workspace = await getWorkspaceById(
      params.id,
      session!.user.id,
      session!.user.role,
    );
  } catch {
    redirect("/workspaces");
  }

  const moduleOn = await isModuleEnabled(
    params.id,
    "crm",
    session!.user.id,
    session!.user.role,
  );
  if (!moduleOn) {
    redirect(`/workspaces/${params.id}`);
  }

  return (
    <WorkspaceBoardShell
      workspace={workspace}
      currentUserId={session!.user.id}
      currentUserRole={session!.user.role}
    />
  );
}
