import { riskSignals } from "@/components/users/users-section-data";
import { StatusPill, Table } from "../users-ui";

export function RisksTab() {
  return (
    <Table
      headers={["Тип", "Сигнал", "Пользователей", "Приоритет"]}
      rows={riskSignals.map((risk) => [
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
