import { events } from "@/components/users/users-section-data";
import { Panel, StatusPill } from "../users-ui";

export function LogsTab() {
  return (
    <Panel title="Лента событий">
      <div className="divide-y divide-border">
        {events.map((event) => (
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
