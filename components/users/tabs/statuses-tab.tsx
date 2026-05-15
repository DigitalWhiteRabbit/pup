import { useState } from "react";
import { ChevronDown, Save } from "lucide-react";
import { careerStatuses } from "@/components/users/users-section-data";
import type { CareerStatus } from "@/components/users/users-section-data";
import { cn } from "@/lib/utils";
import { FilterInput, Panel } from "../users-ui";

export function StatusesTab() {
  const [expanded, setExpanded] = useState(false);
  const [selectedStatusId, setSelectedStatusId] = useState(
    careerStatuses[0]?.id ?? "",
  );
  const selected =
    careerStatuses.find((status) => status.id === selectedStatusId) ??
    careerStatuses[0]!;
  const [conditionDrafts, setConditionDrafts] = useState<
    Record<string, CareerStatus["conditions"]>
  >({});
  const conditions = selected
    ? (conditionDrafts[selected.id] ?? selected.conditions)
    : null;

  function updateCondition(
    key: keyof CareerStatus["conditions"],
    value: string | boolean,
  ) {
    if (!selected) return;
    setConditionDrafts((current) => ({
      ...current,
      [selected.id]: {
        ...(current[selected.id] ?? selected.conditions),
        [key]: value,
      },
    }));
  }

  return (
    <>
      <Panel
        title="Карьерные статусы"
        meta="Список может приходить из API любого проекта и быть любой длины"
      >
        <button
          className="flex h-10 w-full max-w-md items-center justify-between rounded-md border border-border bg-card px-3 text-left text-sm font-medium hover:bg-accent"
          type="button"
          onClick={() => setExpanded((open) => !open)}
        >
          Выбрать статус
          <ChevronDown
            className={cn("h-4 w-4 transition", expanded && "rotate-180")}
          />
        </button>
        {expanded && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {careerStatuses.map((status) => (
              <button
                key={status.id}
                type="button"
                className={cn(
                  "rounded-md border p-3 text-left hover:bg-accent",
                  selectedStatusId === status.id
                    ? "border-foreground bg-accent"
                    : "border-border bg-card",
                )}
                onClick={() => {
                  setSelectedStatusId(status.id);
                  setExpanded(false);
                }}
              >
                <span className="text-xs text-muted-foreground">
                  #{status.order}
                </span>
                <strong className="block">{status.name}</strong>
              </button>
            ))}
          </div>
        )}
      </Panel>

      {conditions && (
        <Panel
          title={`Условия статуса: ${selected.name}`}
          meta={selected.description}
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <FilterInput
              label="Личный объем"
              value={conditions.personalVolume}
              onChange={(value) => updateCondition("personalVolume", value)}
            />
            <FilterInput
              label="Объем первой линии"
              value={conditions.firstLineVolume}
              onChange={(value) => updateCondition("firstLineVolume", value)}
            />
            <FilterInput
              label="Объем структуры"
              value={conditions.structureVolume}
              onChange={(value) => updateCondition("structureVolume", value)}
            />
            <FilterInput
              label="Активные прямые"
              value={conditions.activeDirectUsers}
              onChange={(value) => updateCondition("activeDirectUsers", value)}
            />
            <label className="flex h-10 items-center gap-2 self-end rounded-md border border-border bg-card px-3 text-sm">
              <input
                type="checkbox"
                checked={conditions.activeDepositRequired}
                onChange={(event) =>
                  updateCondition("activeDepositRequired", event.target.checked)
                }
              />
              Нужен активный депозит
            </label>
          </div>
          <button
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-medium text-background"
            type="button"
          >
            <Save className="h-4 w-4" />
            Сохранить условия
          </button>
        </Panel>
      )}
    </>
  );
}
