"use client";

import { ContentCard } from "./ContentCard";
import type { ContentCardView } from "@/lib/content/types";
import { fmtDate, isReady } from "@/lib/content/derive";

export function Board({
  cards,
  activeMetricLabel,
  onClearMetric,
}: {
  cards: ContentCardView[];
  activeMetricLabel: string | null;
  onClearMetric: () => void;
}) {
  // Группировка по дате публикации
  const groups = new Map<string, ContentCardView[]>();
  for (const c of cards) {
    const key = c.publishDate ?? "";
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  return (
    <div>
      {activeMetricLabel && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-[12.5px] font-medium text-emerald-500">
          Активный фильтр: {activeMetricLabel}
          <button
            className="ml-auto px-1 font-bold hover:text-white"
            onClick={onClearMetric}
          >
            ✕ сбросить
          </button>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="rounded-xl border bg-card p-14 text-center text-[13.5px] text-muted-foreground">
          Ничего не найдено по текущим фильтрам.{" "}
          {activeMetricLabel && (
            <button
              className="font-medium text-emerald-500"
              onClick={onClearMetric}
            >
              Сбросить метрику
            </button>
          )}
        </div>
      ) : (
        keys.map((key) => {
          const gc = groups.get(key)!;
          const rdy = gc.filter(isReady).length;
          const pct = Math.round((rdy / gc.length) * 100);
          const toPub = gc.filter(
            (c) => isReady(c) && c.status !== "PUBLISHED",
          ).length;
          const noVis = gc.filter((c) => !c.visualApproved).length;
          return (
            <div key={key || "no-date"} className="mb-7">
              <div className="mb-3.5 flex flex-wrap items-center gap-3">
                <span className="text-base font-bold tracking-tight">
                  {key ? fmtDate(key) : "Без даты"}
                </span>
                <span className="rounded-md bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {gc.length} публ.
                </span>
                <span className="rounded-md bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {toPub} к публикации
                </span>
                <span className="rounded-md bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {noVis} визуал
                </span>
                <span className="ml-auto flex items-center gap-2.5 text-[11.5px] text-muted-foreground">
                  готовность дня {pct}%
                  <span className="h-1.5 w-[86px] overflow-hidden rounded bg-muted">
                    <span
                      className="block h-full bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                </span>
              </div>
              {gc.map((c) => (
                <ContentCard key={c.id} card={c} />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
