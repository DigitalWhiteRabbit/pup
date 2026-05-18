import { Loader2 } from "lucide-react";
import { useEvents } from "../use-users-data";
import { Panel, StatusPill } from "../users-ui";

export function LogsTab({ workspaceId }: { workspaceId: string }) {
  const { data: events, isLoading, error } = useEvents(workspaceId);

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
        Ошибка загрузки логов
      </div>
    );
  }

  const rows = events ?? [];

  return (
    <Panel title="Лента событий">
      <div className="divide-y divide-border">
        {rows.map((event) => (
          <div
            key={`${event.time}-${event.label}`}
            className="grid gap-2 py-4 text-sm sm:grid-cols-[140px_1fr_auto] sm:items-center"
          >
            <span className="text-muted-foreground">{event.time}</span>
            <strong>{event.label}</strong>
            <StatusPill tone={event.tone}>{event.type}</StatusPill>
          </div>
        ))}
      </div>
    </Panel>
  );
}
