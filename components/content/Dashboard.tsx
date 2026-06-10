"use client";

import { Info, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentCardView } from "@/lib/content/types";
import {
  CHANNEL_LABEL,
  CHANNEL_ORDER,
  FORMAT_LABEL,
} from "@/lib/content/constants";
import {
  fmtShort,
  gates,
  isOverdue,
  isReady,
  nextStep,
  todayStr,
} from "@/lib/content/derive";

type Tone = "" | "warn" | "bad" | "good";

export function Dashboard({
  cards,
  activeMetric,
  onApplyMetric,
  onOpenCard,
  channelFilter,
  onFilterChannel,
}: {
  cards: ContentCardView[];
  activeMetric: string | null;
  onApplyMetric: (key: string) => void;
  onOpenCard: (id: string) => void;
  channelFilter: string;
  onFilterChannel: (ch: string) => void;
}) {
  const today = todayStr();
  const total = cards.length;
  const onReview = cards.filter((c) => c.status === "REVIEW").length;
  const checked = cards.filter((c) => c.proofChecked).length;
  const visOk = cards.filter((c) => c.visualApproved).length;
  const toPub = cards.filter(
    (c) => isReady(c) && c.status !== "PUBLISHED",
  ).length;
  const pub = cards.filter((c) => c.status === "PUBLISHED").length;

  const kpis: Array<[string, number, boolean, string]> = [
    ["Карточек", total, true, ""],
    ["На вычитке", onReview, false, "review"],
    ["Проверено", checked, false, "checked"],
    ["Визуал ОК", visOk, false, "visualok"],
    ["К публикации", toPub, true, "ready"],
    ["Опубликовано", pub, false, "published"],
  ];

  const covCheck = total ? Math.round((checked / total) * 100) : 0;
  const linkOk = cards.filter((c) => c.publishedUrl).length;
  const covLink = pub ? Math.round((linkOk / pub) * 100) : 0;

  const metrics: Array<[string, number, string, Tone, string]> = [
    [
      "Просрочено",
      cards.filter((c) => isOverdue(c)).length,
      "нужна новая дата",
      "bad",
      "overdue",
    ],
    [
      "Сегодня",
      cards.filter((c) => c.publishDate === today).length,
      "публикации на сегодня",
      "",
      "today",
    ],
    [
      "Без текста",
      cards.filter((c) => !gates(c).text).length,
      "нет финального текста",
      "warn",
      "notext",
    ],
    ["На вычитку", onReview, "ждут редактора", "warn", "review"],
    [
      "Высокий приоритет",
      cards.filter((c) => c.priority === "HIGH").length,
      "держит запуск",
      "",
      "highprio",
    ],
    ["К публикации", toPub, "текст и визуал согласованы", "good", "ready"],
    [
      "Визуал не готов",
      cards.filter((c) => !c.visualApproved).length,
      "ждёт проверки",
      "warn",
      "novisual",
    ],
    [
      "Согласовать визуал",
      cards.filter((c) => c.visualStatus === "IN_REVIEW").length,
      "визуал на проверке",
      "",
      "needvisual",
    ],
    [
      "Нужны правки",
      cards.filter((c) => c.adminComment && c.status === "DRAFT").length,
      "вернули автору",
      "warn",
      "changes",
    ],
    [
      "Без даты",
      cards.filter((c) => !c.publishDate).length,
      "нужно назначить слот",
      "",
      "nodate",
    ],
    [
      "Без ответственного",
      cards.filter((c) => !c.assignee).length,
      "назначить владельца",
      "",
      "noowner",
    ],
    ["Опубликовано", pub, "ушло в работу", "good", "published"],
  ];

  const upcoming = [...cards]
    .filter(
      (c) =>
        c.publishDate && c.publishDate >= today && c.status !== "PUBLISHED",
    )
    .sort((a, b) => (a.publishDate ?? "").localeCompare(b.publishDate ?? ""))
    .slice(0, 5);

  const chCount = new Map<string, number>();
  for (const c of cards)
    chCount.set(c.channel, (chCount.get(c.channel) ?? 0) + 1);
  const chMax = Math.max(1, ...Array.from(chCount.values()));

  const bottlenecks: Array<[string, number, string]> = [
    ["Без даты", cards.filter((c) => !c.publishDate).length, "nodate"],
    ["Без текста", cards.filter((c) => !gates(c).text).length, "notext"],
    [
      "Правки",
      cards.filter((c) => c.adminComment && c.status === "DRAFT").length,
      "changes",
    ],
    [
      "Визуал не готов",
      cards.filter((c) => !c.visualApproved).length,
      "novisual",
    ],
    ["На вычитке", onReview, "review"],
    ["Готово к публикации", toPub, "ready"],
  ];
  const bMax = Math.max(1, ...bottlenecks.map((b) => b[1]));

  const queue = [...cards]
    .filter((c) => c.status !== "PUBLISHED")
    .sort((a, b) => {
      const ao = isOverdue(a) ? 0 : 1;
      const bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.publishDate ?? "9999").localeCompare(b.publishDate ?? "9999");
    })
    .slice(0, 5);

  const toneText: Record<Tone, string> = {
    "": "",
    warn: "text-amber-500",
    bad: "text-red-500",
    good: "text-emerald-500",
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0 text-emerald-500" />
        Сводный дашборд. Любая плитка-метрика кликабельна — нажми, чтобы открыть
        доску с этим фильтром.
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-6">
        {kpis.map(([label, val, accent, key]) => (
          <button
            key={label}
            onClick={() => onApplyMetric(key)}
            className={cn(
              "rounded-xl border bg-card p-4 text-left transition hover:border-white/20 hover:bg-accent",
              key &&
                activeMetric === key &&
                "border-emerald-500 bg-emerald-500/10",
            )}
          >
            <div
              className={cn(
                "text-[25px] font-bold leading-none",
                accent && "text-emerald-500",
              )}
            >
              {val}
            </div>
            <div className="mt-2 text-[11px] font-medium text-muted-foreground">
              {label}
            </div>
          </button>
        ))}
      </div>

      {/* Coverage */}
      <div className="mt-3.5 flex flex-col gap-3.5 md:flex-row">
        <CoverageBar
          title="Покрытие проверки"
          percent={covCheck}
          sub={`${checked} из ${total} карточек проверены менеджером`}
        />
        <CoverageBar
          title="Покрытие ссылок"
          percent={covLink}
          sub={`${linkOk} из ${pub} опубликованных с валидной ссылкой`}
        />
      </div>

      {/* Metrics */}
      <div className="mb-3 mt-6 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Метрики · быстрые фильтры
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {metrics.map(([label, val, desc, tone, key]) => (
          <button
            key={key}
            onClick={() => onApplyMetric(key)}
            className={cn(
              "rounded-xl border bg-card px-3.5 py-3 text-left transition hover:border-white/20 hover:bg-accent",
              activeMetric === key && "border-emerald-500 bg-emerald-500/10",
            )}
          >
            <div className="text-[11px] font-medium text-muted-foreground">
              {label}
            </div>
            <div className={cn("my-1 text-[21px] font-bold", toneText[tone])}>
              {val}
            </div>
            <div className="text-[10.5px] text-muted-foreground">{desc}</div>
          </button>
        ))}
      </div>

      {/* 3 columns */}
      <div className="mt-6 grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <Panel title="Ближайшие публикации">
          {upcoming.length ? (
            upcoming.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenCard(c.id)}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left transition hover:bg-accent"
              >
                <span className="w-[58px] shrink-0 text-[11.5px] font-semibold text-muted-foreground">
                  {fmtShort(c.publishDate)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{c.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {CHANNEL_LABEL[c.channel]} · {FORMAT_LABEL[c.format]}
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="text-[12.5px] text-muted-foreground">
              нет запланированных
            </div>
          )}
        </Panel>

        <Panel title="Соцсети">
          {CHANNEL_ORDER.filter((ch) => ch !== "ALL" || chCount.get(ch)).map(
            (ch) => (
              <button
                key={ch}
                onClick={() => onFilterChannel(ch)}
                className={cn(
                  "mb-3 flex w-full items-center gap-3",
                  channelFilter === ch && "[&_*]:text-emerald-500",
                )}
              >
                <span className="w-24 text-left text-[13px] text-muted-foreground">
                  {CHANNEL_LABEL[ch]}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                  <span
                    className="block h-full bg-emerald-500"
                    style={{
                      width: `${((chCount.get(ch) ?? 0) / chMax) * 100}%`,
                    }}
                  />
                </span>
                <span className="w-5 text-right text-[13px] font-semibold">
                  {chCount.get(ch) ?? 0}
                </span>
              </button>
            ),
          )}
        </Panel>

        <Panel title="Узкие места">
          {bottlenecks.map(([label, val, key]) => (
            <button
              key={key}
              onClick={() => onApplyMetric(key)}
              className={cn(
                "mb-3 flex w-full items-center gap-3",
                activeMetric === key && "[&_.nm]:text-emerald-500",
              )}
            >
              <span className="nm w-32 text-left text-[13px] text-muted-foreground">
                {label}
              </span>
              <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                <span
                  className="block h-full"
                  style={{
                    width: `${(val / bMax) * 100}%`,
                    background: val ? "var(--amber, #f59e0b)" : "#10b981",
                  }}
                />
              </span>
              <span className="w-5 text-right text-[13px] font-semibold">
                {val}
              </span>
            </button>
          ))}
        </Panel>
      </div>

      {/* Queue */}
      <div className="mt-6 rounded-xl border bg-card p-5">
        <div className="mb-3.5 text-[15px] font-semibold tracking-tight">
          Очередь редакции · что делать первым
        </div>
        {queue.map((c, i) => (
          <button
            key={c.id}
            onClick={() => onOpenCard(c.id)}
            className="flex w-full items-center gap-4 rounded-lg border-b border-border/60 px-2.5 py-3 text-left transition last:border-0 hover:bg-accent"
          >
            <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 py-1 text-xs font-bold text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1">
              <b className="text-[13.5px] font-semibold">{c.title}</b>
              <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                {CHANNEL_LABEL[c.channel]} · {FORMAT_LABEL[c.format]} ·{" "}
                {c.assignee?.login ?? "—"}
              </span>
            </div>
            <div className="text-[12.5px] font-semibold text-sky-400">
              {nextStep(c)}
            </div>
            <div className="w-[92px] text-right text-[11.5px] text-muted-foreground">
              {isOverdue(c) ? (
                <span className="text-red-500">просрочено</span>
              ) : (
                fmtShort(c.publishDate)
              )}
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  );
}

function CoverageBar({
  title,
  percent,
  sub,
}: {
  title: string;
  percent: number;
  sub: string;
}) {
  return (
    <div className="flex-1 rounded-xl border bg-card p-[18px]">
      <div className="mb-2.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">
          {title}
        </span>
        <span className="text-[19px] font-bold">{percent}%</span>
      </div>
      <div className="h-[7px] overflow-hidden rounded bg-muted">
        <div
          className="h-full rounded bg-emerald-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 text-[11.5px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="mb-3.5 text-[15px] font-semibold tracking-tight">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}
