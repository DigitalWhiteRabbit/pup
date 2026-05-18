import { Loader2 } from "lucide-react";
import { useActivity } from "../use-users-data";
import { ChartLines, Panel, SimpleRows } from "../users-ui";

export function ActivityTab({ workspaceId }: { workspaceId: string }) {
  const { data: funnel, isLoading, error } = useActivity(workspaceId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        Ошибка загрузки данных активности
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Воронка действий">
        <SimpleRows rows={funnel ?? []} />
      </Panel>
      <Panel title="Динамика входов">
        <ChartLines />
      </Panel>
    </div>
  );
}
