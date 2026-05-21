"use client";

import { useQuery } from "@tanstack/react-query";
import { Board } from "@/components/board/Board";
import type { WorkspaceBoard } from "@/lib/services/workspace.service";

async function apiFetchWorkspace(workspaceId: string): Promise<WorkspaceBoard> {
  const res = await fetch(`/api/workspaces/${workspaceId}`);
  if (!res.ok) throw new Error("Failed to fetch workspace");
  return res.json() as Promise<WorkspaceBoard>;
}

type Props = {
  workspace: WorkspaceBoard;
  currentUserId: string;
  currentUserRole: "ADMIN" | "USER";
};

export function WorkspaceBoardShell({
  workspace: initialWorkspace,
  currentUserId: _currentUserId,
  currentUserRole: _currentUserRole,
}: Props) {
  const { data: workspace } = useQuery({
    queryKey: ["workspace", initialWorkspace.id],
    queryFn: () => apiFetchWorkspace(initialWorkspace.id),
    initialData: initialWorkspace,
    refetchInterval: 15000,
  });

  return (
    <div className="p-3 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-xl md:text-2xl font-bold">
          {workspace.name} — CRM-доска
        </h1>
        {workspace.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {workspace.description}
          </p>
        )}
      </div>
      <Board initialData={workspace} workspaceId={workspace.id} />
    </div>
  );
}
