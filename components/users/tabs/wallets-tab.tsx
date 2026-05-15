import { useState } from "react";
import { walletRows } from "@/components/users/users-section-data";
import {
  FilterInput,
  FilterSelect,
  Panel,
  StatusPill,
  Table,
} from "../users-ui";
import { includesText, matchesSelect } from "../users-utils";

const walletStatusLabels: Record<string, string> = {
  synced: "Синхронизирован",
  review: "Проверка",
  noOperations: "Нет операций",
};

export function WalletsTab() {
  const emptyFilters = { query: "", wallet: "", status: "all" };
  const [filters, setFilters] = useState(emptyFilters);
  const filteredWallets = walletRows.filter(
    (row) =>
      includesText(row.user, filters.query) &&
      includesText(row.wallet, filters.wallet) &&
      matchesSelect(row.status ?? "", filters.status),
  );

  return (
    <>
      <Panel title="Кошельки" meta={`Найдено: ${filteredWallets.length}`}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_220px_auto]">
          <FilterInput
            label="Пользователь"
            placeholder="Иван / Anna"
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
            label="Статус"
            value={filters.status}
            onChange={(value) =>
              setFilters((current) => ({ ...current, status: value }))
            }
            options={[
              { value: "all", label: "all" },
              { value: "synced", label: "Синхронизирован" },
              { value: "review", label: "Проверка" },
              { value: "noOperations", label: "Нет операций" },
            ]}
          />
          <button
            className="h-10 self-end rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
            type="button"
            onClick={() => setFilters(emptyFilters)}
          >
            Сбросить
          </button>
        </div>
      </Panel>
      <Table
        headers={[
          "Пользователь",
          "Кошелек",
          "Сеть",
          "TX",
          "Объем",
          "Последняя операция",
          "Статус",
        ]}
        rows={filteredWallets.map((row) => [
          row.user,
          row.wallet,
          row.network,
          String(row.txCount),
          row.volume,
          row.lastOperation,
          <StatusPill key={row.wallet} tone={row.tone}>
            {walletStatusLabels[row.status as keyof typeof walletStatusLabels]}
          </StatusPill>,
        ])}
      />
    </>
  );
}
