import { auth } from "@/lib/auth";
import { getWorkspacesForUser } from "@/lib/services/workspace.service";
import { WorkspacesClient } from "./workspaces-client";

export default async function WorkspacesPage() {
  const session = await auth();
  const initialData = await getWorkspacesForUser(
    session!.user.id,
    session!.user.role,
    1,
    20,
  );

  return <WorkspacesClient initialData={initialData} />;
}
