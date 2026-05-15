import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { operationRows } from "@/components/users/users-section-data";
import {
  FilterInput,
  FilterSelect,
  Panel,
  StatusPill,
  Table,
} from "../users-ui";
import { includesText, inDateRange, matchesSelect } from "../users-utils";

const operationTypeLabels: Record<string, string> = {
  deposit: "Депозит",
  withdrawal: "Вывод",
  referralAccrual: "Реферальное начисление",
  statusVolumeSync: "Синхронизация объема",
  treeRecalculation: "Перерасчет дерева",
};

const operationStatusLabels: Record<string, string> = {
  confirmed: "Подтверждено",
  review: "Проверка",
  rejected: "Отклонено",
};

export function OperationsHistoryTab() {
  const emptyFilters = {
    dateFrom: "",
    dateTo: "",
    query: "",
    wallet: "",
    type: "all",
    status: "all",
  };
  const [filters, setFilters] = useState(emptyFilters);
  const filteredOperations = operationRows.filter(
    (operation) =>
      inDateRange(operation.time, filters.dateFrom, filters.dateTo) &&
      includesText(operation.user, filters.query) &&
      includesText(operation.wallet, filters.wallet) &&
      matchesSelect(operation.type, filters.type) &&
      matchesSelect(operation.status, filters.status),
  );

  return (
    <>
      <Panel
        title="История операций"
        meta={`Найдено: ${filteredOperations.length}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Период</span>
            <input
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              type="date"
              value={filters.dateFrom}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  dateFrom: event.target.value,
                }))
              }
              aria-label="Период с"
            />
            <input
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
              type="date"
              value={filters.dateTo}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  dateTo: event.target.value,
                }))
              }
              aria-label="Период по"
            />
            <button
              className="grid h-9 w-9 place-items-center rounded-md border border-border bg-card hover:bg-accent"
              type="button"
              aria-label="Применить период"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <FilterInput
            label="ID / имя"
            placeholder="10492 / Иван"
            value={filters.query}
            onChange={(value) =>
              setFilters((current) => ({ ...current, query: value }))
            }
          />
          <FilterInput
            label="Кошелек"
            placeholder="0x..."
            value={filters.wallet}
            onChange={(value) =>
              setFilters((current) => ({ ...current, wallet: value }))
            }
          />
          <FilterSelect
            label="Тип"
            value={filters.type}
            onChange={(value) =>
              setFilters((current) => ({ ...current, type: value }))
            }
            options={[
              { value: "all", label: "all" },
              ...Object.entries(operationTypeLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <FilterSelect
            label="Статус"
            value={filters.status}
            onChange={(value) =>
              setFilters((current) => ({ ...current, status: value }))
            }
            options={[
              { value: "all", label: "all" },
              ...Object.entries(operationStatusLabels).map(
                ([value, label]) => ({ value, label }),
              ),
            ]}
          />
        </div>
        <button
          className="mt-4 h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
          type="button"
          onClick={() => setFilters(emptyFilters)}
        >
          Сбросить
        </button>
      </Panel>
      <Table
        headers={[
          "Время",
          "Пользователь",
          "Тип",
          "Сумма",
          "Сеть",
          "Кошелек",
          "TX",
          "Статус",
        ]}
        rows={filteredOperations.map((row) => [
          row.time,
          row.user,
          operationTypeLabels[row.type],
          row.amount,
          row.network,
          row.wallet,
          row.tx,
          <StatusPill key={row.id} tone={row.tone}>
            {operationStatusLabels[row.status]}
          </StatusPill>,
        ])}
      />
    </>
  );
}
