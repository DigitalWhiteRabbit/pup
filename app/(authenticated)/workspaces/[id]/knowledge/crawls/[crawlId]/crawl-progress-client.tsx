"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ChevronLeft,
  Loader2,
  XCircle,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type {
  KbCrawlView,
  KbCrawlPageView,
} from "@/lib/services/kb/crawler.service";

type CrawlFull = KbCrawlView & { pages: KbCrawlPageView[] };

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Ожидание",
  RUNNING: "Выполняется",
  COMPLETED: "Завершён",
  FAILED: "Ошибка",
  CANCELLED: "Отменён",
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  PENDING: "secondary",
  RUNNING: "default",
  COMPLETED: "secondary",
  FAILED: "destructive",
  CANCELLED: "outline",
};

function elapsed(startedAt: Date | null): string {
  if (!startedAt) return "—";
  const s = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (s < 60) return `${s}с`;
  return `${Math.floor(s / 60)}м ${s % 60}с`;
}

export function CrawlProgressClient({
  initialCrawl,
  workspaceId,
}: {
  initialCrawl: CrawlFull;
  workspaceId: string;
}) {
  const router = useRouter();
  const isActive =
    initialCrawl.status === "RUNNING" || initialCrawl.status === "PENDING";

  const { data: crawl = initialCrawl } = useQuery<CrawlFull>({
    queryKey: ["crawl", initialCrawl.id],
    queryFn: async () => {
      const r = await fetch(`/api/kb/crawls/${initialCrawl.id}`);
      return r.json() as Promise<CrawlFull>;
    },
    refetchInterval: isActive ? 2000 : false,
    initialData: initialCrawl,
  });

  const cancelMut = useMutation({
    mutationFn: () =>
      fetch(`/api/kb/crawls/${crawl.id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toastSuccess("Crawl отменён");
      router.refresh();
    },
    onError: toastApiError,
  });

  const pct =
    crawl.maxPages > 0
      ? Math.min(100, Math.round((crawl.pagesCompleted / crawl.maxPages) * 100))
      : 0;

  const pageStatusBadge = (s: string) => {
    if (s === "completed")
      return (
        <Badge variant="secondary" className="text-xs">
          ✓
        </Badge>
      );
    if (s === "failed")
      return (
        <Badge variant="destructive" className="text-xs">
          ✗
        </Badge>
      );
    if (s === "skipped")
      return (
        <Badge variant="outline" className="text-xs">
          ~
        </Badge>
      );
    return (
      <Badge variant="outline" className="text-xs">
        …
      </Badge>
    );
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={`/workspaces/${workspaceId}/knowledge`}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Назад к базе знаний
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold truncate">
            Crawl: {crawl.startUrl}
          </h1>
          <Badge variant={STATUS_VARIANT[crawl.status] ?? "secondary"}>
            {STATUS_LABEL[crawl.status] ?? crawl.status}
          </Badge>
        </div>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>
            Страниц: {crawl.pagesCompleted} / {crawl.maxPages}
          </span>
          <span>{pct}%</span>
        </div>
        <Progress value={pct} />
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: "Создано статей",
            value: crawl.articlesCreated,
            icon: <CheckCircle2 className="h-4 w-4 text-green-500" />,
          },
          {
            label: "Ошибок",
            value: crawl.pagesFailed,
            icon: <AlertCircle className="h-4 w-4 text-destructive" />,
          },
          { label: "Глубина", value: crawl.currentDepth, icon: null },
          {
            label: "Время",
            value: elapsed(crawl.startedAt),
            icon: <Clock className="h-4 w-4 text-muted-foreground" />,
          },
        ].map((m) => (
          <div key={m.label} className="border rounded-md p-3 space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {m.icon}
              {m.label}
            </div>
            <p className="font-bold text-lg">{m.value}</p>
          </div>
        ))}
      </div>

      {crawl.error && (
        <div className="text-sm text-destructive border border-destructive/30 rounded-md p-3">
          {crawl.error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {(crawl.status === "RUNNING" || crawl.status === "PENDING") && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => cancelMut.mutate()}
            disabled={cancelMut.isPending}
          >
            {cancelMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="h-4 w-4 mr-1" />
            )}
            Отменить
          </Button>
        )}
        {crawl.status === "COMPLETED" && (
          <Button asChild size="sm">
            <Link href={`/workspaces/${workspaceId}/knowledge`}>
              Перейти к статьям
            </Link>
          </Button>
        )}
      </div>

      {/* Pages list */}
      {crawl.pages.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold text-sm">
            Страницы ({crawl.pages.length})
          </h2>
          <div className="border rounded-md divide-y max-h-96 overflow-y-auto">
            {crawl.pages.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 px-3 py-2 text-xs"
              >
                {pageStatusBadge(p.status)}
                <span className="text-muted-foreground w-6 shrink-0">
                  d{p.depth}
                </span>
                <span className="truncate flex-1">{p.url}</span>
                {p.articleId && (
                  <Link
                    href={`/workspaces/${workspaceId}/knowledge/${p.articleId}`}
                    className="text-primary hover:underline shrink-0"
                  >
                    Статья
                  </Link>
                )}
                {p.error && (
                  <span className="text-destructive truncate max-w-[120px]">
                    {p.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
