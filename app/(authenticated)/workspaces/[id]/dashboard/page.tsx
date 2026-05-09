import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getWorkspaceById } from "@/lib/services/workspace.service";

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
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{workspace.name} — Dashboard</h1>
        {workspace.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {workspace.description}
          </p>
        )}
      </div>
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed text-muted-foreground text-sm">
        Здесь будет общий дашборд проекта
      </div>
    </div>
  );
}
