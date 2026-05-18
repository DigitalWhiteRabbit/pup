"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Clock, ListTodo, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TaskModal } from "@/components/board/TaskModal";
import { WorkspaceLogo } from "@/components/ui/workspace-logo";
import type { WorkspaceBoard } from "@/lib/services/workspace.service";

async function fetchWorkspace(id: string): Promise<WorkspaceBoard> {
  const res = await fetch(`/api/workspaces/${id}`);
  if (!res.ok) throw new Error("Failed to fetch workspace");
  return res.json() as Promise<WorkspaceBoard>;
}

type Props = {
  workspace: WorkspaceBoard;
  currentUserId: string;
};

function columnStatusClass(name: string): string {
  const n = name.toLowerCase();
  if (
    n.includes("готов") ||
    n.includes("done") ||
    n.includes("завершен") ||
    n.includes("complete")
  )
    return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  if (
    n.includes("работ") ||
    n.includes("прогресс") ||
    n.includes("progress") ||
    n.includes("в процессе")
  )
    return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  if (n.includes("блок") || n.includes("отменен") || n.includes("стоп"))
    return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  if (n.includes("провер") || n.includes("review") || n.includes("тест"))
    return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
  // default — ожидает / backlog / todo
  return "bg-muted text-muted-foreground";
}

function isDoneColumn(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("готов") ||
    n.includes("done") ||
    n.includes("завершен") ||
    n.includes("complete")
  );
}

export function WorkspaceDashboard({
  workspace: initialWorkspace,
  currentUserId,
}: Props) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: workspace } = useQuery({
    queryKey: ["workspace", initialWorkspace.id],
    queryFn: () => fetchWorkspace(initialWorkspace.id),
    initialData: initialWorkspace,
    refetchInterval: 5000,
  });

  const allTasks = useMemo(
    () =>
      workspace.columns.flatMap((c) =>
        c.tasks.map((t) => ({ ...t, columnName: c.name })),
      ),
    [workspace],
  );

  const totalTasks = allTasks.length;
  const inProgressTasks = allTasks.filter((t) => t.isInProgress);
  const doneTasks = allTasks.filter((t) => isDoneColumn(t.columnName));
  const myTasks = allTasks.filter(
    (t) =>
      t.assignees.some((a) => a.id === currentUserId) &&
      !isDoneColumn(t.columnName),
  );

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      <div className="flex items-center gap-3 md:gap-4">
        <WorkspaceLogo
          workspaceId={workspace.id}
          name={workspace.name}
          hasLogo={!!workspace.logoPath}
          size={48}
          className="rounded-xl hidden md:block"
        />
        <WorkspaceLogo
          workspaceId={workspace.id}
          name={workspace.name}
          hasLogo={!!workspace.logoPath}
          size={36}
          className="rounded-xl md:hidden"
        />
        <div>
          <h1 className="text-xl md:text-2xl font-bold">{workspace.name}</h1>
          {workspace.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {workspace.description}
            </p>
          )}
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-primary/10 p-2">
                <ListTodo className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalTasks}</p>
                <p className="text-xs text-muted-foreground">Всего задач</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-blue-500/10 p-2">
                <Clock className="h-4 w-4 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{inProgressTasks.length}</p>
                <p className="text-xs text-muted-foreground">В работе сейчас</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-green-500/10 p-2">
                <CheckSquare className="h-4 w-4 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{doneTasks.length}</p>
                <p className="text-xs text-muted-foreground">Готово</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-orange-500/10 p-2">
                <TrendingUp className="h-4 w-4 text-orange-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{myTasks.length}</p>
                <p className="text-xs text-muted-foreground">Мои задачи</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Cards row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* My tasks */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Мои задачи</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {myTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                Нет назначенных задач
              </p>
            ) : (
              myTasks.slice(0, 8).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTaskId(t.id)}
                  className="w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent transition-colors"
                >
                  <span className="text-sm truncate">{t.title}</span>
                  <span
                    className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium ${columnStatusClass(t.columnName)}`}
                  >
                    {t.columnName}
                  </span>
                </button>
              ))
            )}
            {myTasks.length > 8 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{myTasks.length - 8} ещё
              </p>
            )}
          </CardContent>
        </Card>

        {/* Tasks by column */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">По колонкам</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {workspace.columns
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((col) => {
                const pct =
                  totalTasks > 0
                    ? Math.round((col.tasks.length / totalTasks) * 100)
                    : 0;
                return (
                  <div key={col.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{col.name}</span>
                      <span className="font-medium">{col.tasks.length}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            <Link
              href={`/workspaces/${workspace.id}/crm`}
              className="block text-center text-xs text-primary hover:underline pt-2"
            >
              Открыть CRM-доску →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* ── Task modal ── */}
      {selectedTaskId && (
        <TaskModal
          taskId={selectedTaskId}
          workspaceId={workspace.id}
          members={workspace.members}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
