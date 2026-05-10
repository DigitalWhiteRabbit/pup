"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckSquare,
  MessageSquare,
  Paperclip,
  Columns,
  Folder,
  User,
  ChevronDown,
  ChevronUp,
  XCircle,
} from "lucide-react";
import type { ActivityAction } from "@prisma/client";
import type { ActivityLogItem } from "@/lib/services/logger.service";

type GlobalLogItem = ActivityLogItem & { workspaceName: string | null };
type PaginatedGlobal = { data: GlobalLogItem[]; total: number };
type WorkspaceSummary = { id: string; name: string };

const ACTION_GROUPS: Record<string, ActivityAction[]> = {
  Задачи: [
    "TASK_CREATED",
    "TASK_DELETED",
    "TASK_MOVED",
    "TASK_UPDATED",
    "TASK_ASSIGNEE_ADDED",
    "TASK_ASSIGNEE_REMOVED",
    "TASK_PRIORITY_CHANGED",
    "TASK_DATE_CHANGED",
  ],
  "Комментарии и файлы": [
    "COMMENT_CREATED",
    "COMMENT_UPDATED",
    "COMMENT_DELETED",
    "ATTACHMENT_UPLOADED",
    "ATTACHMENT_DELETED",
  ],
  Колонки: ["COLUMN_CREATED", "COLUMN_RENAMED", "COLUMN_DELETED"],
  Workspace: [
    "WORKSPACE_CREATED",
    "WORKSPACE_UPDATED",
    "MEMBER_ADDED",
    "MEMBER_REMOVED",
    "MEMBER_ROLE_CHANGED",
    "MODULE_ENABLED",
    "MODULE_DISABLED",
  ],
};

const PAGE_SIZE = 50;

function getActionIcon(action: ActivityAction) {
  const cls = "h-4 w-4 shrink-0 text-muted-foreground";
  if (action.startsWith("TASK_")) return <CheckSquare className={cls} />;
  if (action.startsWith("COMMENT_")) return <MessageSquare className={cls} />;
  if (action.startsWith("ATTACHMENT_")) return <Paperclip className={cls} />;
  if (action.startsWith("COLUMN_")) return <Columns className={cls} />;
  if (
    action.startsWith("WORKSPACE_") ||
    action.startsWith("MEMBER_") ||
    action.startsWith("MODULE_")
  )
    return <Folder className={cls} />;
  return <User className={cls} />;
}

function LogRow({ log }: { log: GlobalLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(log.metadata).length > 0;

  return (
    <Card className="shadow-none border-border/60">
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{getActionIcon(log.action)}</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm leading-snug">{log.summary}</p>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {log.workspaceName && (
                <Badge
                  variant="outline"
                  className="text-[10px] py-0 px-1.5 font-normal"
                >
                  {log.workspaceName}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(log.createdAt), {
                  addSuffix: true,
                  locale: ru,
                })}
              </span>
            </div>
          </div>
          {hasMetadata && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
        {expanded && hasMetadata && (
          <pre className="mt-3 text-xs bg-muted rounded p-2 overflow-auto max-h-40 text-muted-foreground">
            {JSON.stringify(log.metadata, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function LogSkeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i} className="shadow-none border-border/60">
          <CardContent className="py-3 px-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 mt-0.5 rounded shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function GlobalLogsClient() {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState("all");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const { data: workspaces } = useQuery<{ data: WorkspaceSummary[] }>({
    queryKey: ["workspaces-global-logs"],
    queryFn: () => fetch("/api/workspaces?limit=100").then((r) => r.json()),
    staleTime: 60_000,
  });

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (actionFilter !== "all") {
    const actions = ACTION_GROUPS[actionFilter];
    if (actions) params.set("actions", actions.join(","));
  }
  if (workspaceFilter !== "all") params.set("workspaceId", workspaceFilter);
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery<PaginatedGlobal>({
    queryKey: [
      "global-activity-logs",
      page,
      actionFilter,
      workspaceFilter,
      search,
    ],
    queryFn: () =>
      fetch(`/api/logs/activity?${params.toString()}`).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;
  const hasFilters =
    actionFilter !== "all" || workspaceFilter !== "all" || search !== "";

  function reset() {
    setActionFilter("all");
    setWorkspaceFilter("all");
    setSearch("");
    setSearchInput("");
    setPage(1);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Все логи</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select
          value={workspaceFilter}
          onValueChange={(v) => {
            setWorkspaceFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Все проекты" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все проекты</SelectItem>
            {workspaces?.data?.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={actionFilter}
          onValueChange={(v) => {
            setActionFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Тип событий" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все события</SelectItem>
            {Object.keys(ACTION_GROUPS).map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchInput.trim());
            setPage(1);
          }}
        >
          <Input
            placeholder="Поиск по тексту..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-52"
          />
          <Button type="submit" variant="outline" size="sm">
            Найти
          </Button>
        </form>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            className="text-muted-foreground"
          >
            <XCircle className="h-4 w-4 mr-1" />
            Сбросить
          </Button>
        )}
      </div>

      {data && (
        <p className="text-xs text-muted-foreground mb-3">
          {data.total} событий по всем проектам
        </p>
      )}

      {isLoading ? (
        <LogSkeletons />
      ) : !data || data.data.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">Событий не найдено</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.data.map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <span className="text-sm text-muted-foreground">
            Страница {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
