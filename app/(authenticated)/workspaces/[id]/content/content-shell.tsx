"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, CalendarRange, Shield, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { toastSuccess, toastError } from "@/lib/toast";
import {
  ContentContext,
  type LightboxContent,
  type ContentMember,
} from "@/components/content/context";
import { Dashboard } from "@/components/content/Dashboard";
import { Board } from "@/components/content/Board";
import { Moderation } from "@/components/content/Moderation";
import { CardModal } from "@/components/content/CardModal";
import { Lightbox } from "@/components/content/Lightbox";
import {
  Filters,
  EMPTY_FILTER,
  type BoardFilter,
} from "@/components/content/Filters";
import { METRIC_LABEL, passMetric } from "@/components/content/metrics";
import type { ContentCardView } from "@/lib/content/types";
import type { CardAction } from "@/lib/content/types";
import type { CardStatus } from "@/lib/content/constants";
import { isReady } from "@/lib/content/derive";

type Tab = "dash" | "board" | "mod";

async function fetchCards(workspaceId: string): Promise<ContentCardView[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/content/cards`);
  if (!res.ok) throw new Error("Не удалось загрузить карточки");
  const data = (await res.json()) as { data: ContentCardView[] };
  return data.data;
}

export function ContentShell({
  workspaceId,
  workspaceName,
  isModerator,
  currentUserId,
  members,
}: {
  workspaceId: string;
  workspaceName: string;
  isModerator: boolean;
  currentUserId: string;
  members: ContentMember[];
}) {
  const queryClient = useQueryClient();
  const { data: cards = [] } = useQuery({
    queryKey: ["content", "cards", workspaceId],
    queryFn: () => fetchCards(workspaceId),
    refetchInterval: 20000,
  });

  const [tab, setTab] = useState<Tab>("dash");
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
  const [activeMetric, setActiveMetric] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{
    open: boolean;
    card: ContentCardView | null;
  }>({
    open: false,
    card: null,
  });
  const [lightbox, setLightbox] = useState<LightboxContent | null>(null);

  const invalidate = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ["content", "cards", workspaceId],
      }),
    [queryClient, workspaceId],
  );

  const base = `/api/workspaces/${workspaceId}/content`;

  const run = useCallback(
    async (req: Promise<Response>, okMsg?: string) => {
      try {
        const res = await req;
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error ?? "Ошибка запроса");
        }
        if (okMsg) toastSuccess(okMsg);
        await invalidate();
      } catch (e) {
        toastError(e instanceof Error ? e.message : "Ошибка");
      }
    },
    [invalidate],
  );

  const post = (url: string, body?: unknown) =>
    fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  const patch = (url: string, body: unknown) =>
    fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const ACTION_MSG: Record<CardAction, string> = {
    review: "Отправлено на вычитку",
    "request-changes": "Возвращено автору на правки",
    approve: "Текст проверен",
    "approve-visual": "Визуал согласован",
    publish: "Опубликовано",
  };

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openCard = useCallback((id: string) => {
    setFilter(EMPTY_FILTER);
    setActiveMetric(null);
    setExpanded((prev) => new Set(prev).add(id));
    setTab("board");
    setTimeout(() => {
      const el = document.getElementById(`content-card-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }, []);

  const applyMetric = useCallback((key: string) => {
    if (!key) {
      setTab("board");
      return;
    }
    setActiveMetric((cur) => (cur === key ? null : key));
    setTab("board");
  }, []);

  const filterChannel = useCallback((ch: string) => {
    setFilter((f) => ({ ...f, channel: f.channel === ch ? "" : ch }));
    setActiveMetric(null);
    setTab("board");
  }, []);

  // ── Filtered list for the board ──
  const filteredCards = useMemo(() => {
    const s = filter.search.toLowerCase();
    return cards.filter((c) => {
      if (
        s &&
        !`${c.title}${c.text ?? ""}${c.workComment ?? ""}${c.adminComment ?? ""}`
          .toLowerCase()
          .includes(s)
      )
        return false;
      if (filter.channel && c.channel !== filter.channel) return false;
      if (filter.status && c.status !== filter.status) return false;
      if (filter.priority && c.priority !== filter.priority) return false;
      if (filter.format && c.format !== filter.format) return false;
      if (filter.ready === "ready" && !isReady(c)) return false;
      if (filter.ready === "notready" && isReady(c)) return false;
      if (activeMetric && !passMetric(c, activeMetric)) return false;
      return true;
    });
  }, [cards, filter, activeMetric]);

  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      const anyOpen = filteredCards.some((c) => prev.has(c.id));
      if (anyOpen) return new Set();
      return new Set(filteredCards.map((c) => c.id));
    });
  }, [filteredCards]);

  const ctx = useMemo(
    () => ({
      workspaceId,
      isModerator,
      currentUserId,
      members,
      expanded,
      toggleExpand,
      openCreate: () => setModal({ open: true, card: null }),
      openEdit: (card: ContentCardView) => setModal({ open: true, card }),
      openLightbox: (content: LightboxContent) => setLightbox(content),
      doAction: (cardId: string, action: CardAction, publishedUrl?: string) =>
        run(
          post(`${base}/cards/${cardId}/action`, {
            action,
            ...(publishedUrl ? { publishedUrl } : {}),
          }),
          ACTION_MSG[action],
        ),
      doDuplicate: (cardId: string) =>
        run(post(`${base}/cards/${cardId}/duplicate`), "Карточка дублирована"),
      doShiftDate: (cardId: string, delta: number) =>
        run(
          post(`${base}/cards/${cardId}/shift-date`, { delta }),
          delta > 0 ? "Дата +1 день" : "Дата −1 день",
        ),
      doDelete: (cardId: string, title: string) => {
        if (!window.confirm(`Удалить карточку «${title}»?`))
          return Promise.resolve();
        return run(
          fetch(`${base}/cards/${cardId}`, { method: "DELETE" }),
          "Карточка удалена",
        );
      },
      doSetStatus: (cardId: string, status: CardStatus) =>
        run(patch(`${base}/cards/${cardId}`, { status })),
      doSetAdminComment: (cardId: string, value: string) =>
        run(
          patch(`${base}/cards/${cardId}`, { adminComment: value }),
          "Комментарий сохранён",
        ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      workspaceId,
      isModerator,
      currentUserId,
      members,
      expanded,
      toggleExpand,
      run,
    ],
  );

  // Если модерация скрылась, а вкладка была на ней
  if (tab === "mod" && !isModerator) setTab("board");

  const reviewCount = cards.filter((c) => c.status === "REVIEW").length;

  const tabs: Array<{
    key: Tab;
    label: string;
    icon: React.ReactNode;
    count?: number;
  }> = [
    {
      key: "dash",
      label: "Дашборд",
      icon: <LayoutDashboard className="h-4 w-4" />,
    },
    {
      key: "board",
      label: "Доска",
      icon: <CalendarRange className="h-4 w-4" />,
      count: cards.length,
    },
    ...(isModerator
      ? [
          {
            key: "mod" as Tab,
            label: "Модерация",
            icon: <Shield className="h-4 w-4" />,
            count: reviewCount,
          },
        ]
      : []),
  ];

  return (
    <ContentContext.Provider value={ctx}>
      <div className="p-3 md:p-6">
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">
            Контент-план
          </h1>
          <span className="text-sm text-muted-foreground">
            · {workspaceName}
          </span>
          {isModerator && (
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-500">
              Старший менеджер
            </span>
          )}
          <button
            onClick={() => setModal({ open: true, card: null })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Новая карточка
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-5 flex items-center gap-1 border-b">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13.5px] font-medium transition",
                tab === t.key
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
              {t.count !== undefined && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[11px] font-semibold",
                    tab === t.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "dash" && (
          <Dashboard
            cards={cards}
            activeMetric={activeMetric}
            onApplyMetric={applyMetric}
            onOpenCard={openCard}
            channelFilter={filter.channel}
            onFilterChannel={filterChannel}
          />
        )}
        {tab === "board" && (
          <>
            <Filters
              filter={filter}
              setFilter={setFilter}
              onToggleAll={toggleAll}
              onReset={() => {
                setFilter(EMPTY_FILTER);
                setActiveMetric(null);
              }}
            />
            <Board
              cards={filteredCards}
              activeMetricLabel={
                activeMetric
                  ? (METRIC_LABEL[activeMetric] ?? activeMetric)
                  : null
              }
              onClearMetric={() => setActiveMetric(null)}
            />
          </>
        )}
        {tab === "mod" && isModerator && <Moderation cards={cards} />}
      </div>

      <CardModal
        open={modal.open}
        card={modal.card}
        members={members}
        workspaceId={workspaceId}
        onClose={() => setModal({ open: false, card: null })}
        onComplete={(newId) => {
          setModal({ open: false, card: null });
          void invalidate();
          if (newId) {
            setExpanded((prev) => new Set(prev).add(newId));
            setTab("board");
          }
        }}
      />

      <Lightbox content={lightbox} onClose={() => setLightbox(null)} />
    </ContentContext.Provider>
  );
}
