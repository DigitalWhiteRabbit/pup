import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getWorkspaceById } from "@/lib/services/workspace.service";
import { WorkspaceDashboard } from "./WorkspaceDashboard";

type Props = { params: { id: string } };

export default async function DashboardPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const workspace = await getWorkspaceById(
    params.id,
    session.user.id,
    session.user.role,
  );
  if (!workspace) redirect("/workspaces");

  return (
    <WorkspaceDashboard workspace={workspace} currentUserId={session.user.id} />
  );
}
