import { Loader2 } from "lucide-react";
import { useRiskSignals } from "../use-users-data";
import { StatusPill, Table } from "../users-ui";

export function RisksTab({ workspaceId }: { workspaceId: string }) {
  const { data: riskSignals, isLoading, error } = useRiskSignals(workspaceId);

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
        Ошибка загрузки рисков
      </div>
    );
  }

  const signals = riskSignals ?? [];

  return (
    <Table
      headers={["Тип", "Сигнал", "Пользователей", "Приоритет"]}
      rows={signals.map((risk) => [
        risk.type,
        risk.signal,
        String(risk.users),
        <StatusPill key={risk.signal} tone={risk.tone}>
          {risk.priority}
        </StatusPill>,
      ])}
    />
  );
}
