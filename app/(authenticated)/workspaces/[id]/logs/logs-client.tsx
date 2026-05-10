"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
import type {
  ActivityLogItem,
  SystemLogItem,
} from "@/lib/services/logger.service";
import type { ActivityAction, LogLevel } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string;
};

type PaginatedActivity = { data: ActivityLogItem[]; total: number };
type PaginatedSystem = { data: SystemLogItem[]; total: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTION_GROUPS: Record<string, ActivityAction[]> = {
  Задачи: [
    "TASK_CREATED",
    "TASK_DELETED",
    "TASK_MOVED",
    "TASK_UPDATED",
    "TASK_ASSIGNEE_ADDED",
    "TASK_ASSIGNEE_REMOVED",
    "TASK_LABEL_ADDED",
    "TASK_LABEL_REMOVED",
    "TASK_PRIORITY_CHANGED",
    "TASK_DATE_CHANGED",
    "TASK_CHECKLIST_ITEM_ADDED",
    "TASK_CHECKLIST_ITEM_TOGGLED",
    "TASK_CHECKLIST_ITEM_REMOVED",
  ],
  "Комментарии и файлы": [
    "COMMENT_CREATED",
    "COMMENT_UPDATED",
    "COMMENT_DELETED",
    "ATTACHMENT_UPLOADED",
    "ATTACHMENT_DELETED",
  ],
  Колонки: [
    "COLUMN_CREATED",
    "COLUMN_RENAMED",
    "COLUMN_DELETED",
    "COLUMN_REORDERED",
  ],
  Workspace: [
    "WORKSPACE_CREATED",
    "WORKSPACE_UPDATED",
    "WORKSPACE_DELETED",
    "MEMBER_ADDED",
    "MEMBER_REMOVED",
    "MEMBER_ROLE_CHANGED",
    "MODULE_ENABLED",
    "MODULE_DISABLED",
  ],
  Система: [
    "USER_LOGIN",
    "USER_LOGOUT",
    "USER_CREATED_BY_ADMIN",
    "USER_DEACTIVATED",
    "USER_ACTIVATED",
    "USER_PASSWORD_RESET",
    "USER_ROLE_CHANGED",
  ],
};

const ACTION_LABELS: Partial<Record<ActivityAction, string>> = {
  TASK_CREATED: "Создание задачи",
  TASK_DELETED: "Удаление задачи",
  TASK_MOVED: "Перемещение задачи",
  TASK_UPDATED: "Обновление задачи",
  TASK_ASSIGNEE_ADDED: "Назначение",
  TASK_ASSIGNEE_REMOVED: "Снятие назначения",
  TASK_PRIORITY_CHANGED: "Изменение приоритета",
  TASK_DATE_CHANGED: "Изменение дат",
  COMMENT_CREATED: "Комментарий",
  COMMENT_UPDATED: "Редактирование коммент.",
  COMMENT_DELETED: "Удаление коммент.",
  ATTACHMENT_UPLOADED: "Загрузка файла",
  ATTACHMENT_DELETED: "Удаление файла",
  COLUMN_CREATED: "Создание колонки",
  COLUMN_RENAMED: "Переименование колонки",
  COLUMN_DELETED: "Удаление колонки",
  WORKSPACE_CREATED: "Создание workspace",
  WORKSPACE_UPDATED: "Обновление workspace",
  WORKSPACE_DELETED: "Удаление workspace",
  MEMBER_ADDED: "Добавление участника",
  MEMBER_REMOVED: "Удаление участника",
  MEMBER_ROLE_CHANGED: "Изменение роли",
  MODULE_ENABLED: "Включение модуля",
  MODULE_DISABLED: "Отключение модуля",
  USER_LOGIN: "Вход",
  USER_CREATED_BY_ADMIN: "Создание юзера",
  USER_DEACTIVATED: "Деактивация",
  USER_ACTIVATED: "Активация",
  USER_ROLE_CHANGED: "Изменение роли",
};

const PAGE_SIZE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActionIcon(action: ActivityAction) {
  const className = "h-4 w-4 shrink-0";
  if (action.startsWith("TASK_")) return <CheckSquare className={className} />;
  if (action.startsWith("COMMENT_"))
    return <MessageSquare className={className} />;
  if (action.startsWith("ATTACHMENT_"))
    return <Paperclip className={className} />;
  if (action.startsWith("COLUMN_")) return <Columns className={className} />;
  if (
    action.startsWith("WORKSPACE_") ||
    action.startsWith("MEMBER_") ||
    action.startsWith("MODULE_")
  )
    return <Folder className={className} />;
  return <User className={className} />;
}

function levelBadgeVariant(
  level: LogLevel,
): "default" | "secondary" | "destructive" {
  if (level === "ERROR") return "destructive";
  if (level === "WARN") return "secondary";
  return "default";
}

function RelativeTime({ date }: { date: string | Date }) {
  return (
    <span className="text-xs text-muted-foreground whitespace-nowrap">
      {formatDistanceToNow(new Date(date), { addSuffix: true, locale: ru })}
    </span>
  );
}

// ─── ActivityLogRow ────────────────────────────────────────────────────────────

function ActivityLogRow({ log }: { log: ActivityLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(log.metadata).length > 0;

  return (
    <Card className="shadow-none border-border/60">
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">
            {getActionIcon(log.action)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm leading-snug">{log.summary}</p>
            <div className="flex items-center gap-2 mt-1">
              <Badge
                variant="secondary"
                className="text-xs py-0 px-1.5 font-normal"
              >
                {ACTION_LABELS[log.action] ?? log.action}
              </Badge>
              <RelativeTime date={log.createdAt} />
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

// ─── SystemLogRow ──────────────────────────────────────────────────────────────

function SystemLogRow({ log }: { log: SystemLogItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="shadow-none border-border/60">
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <Badge
            variant={levelBadgeVariant(log.level)}
            className="text-xs py-0 px-1.5 shrink-0 mt-0.5"
          >
            {log.level}
          </Badge>
          <div className="flex-1 min-w-0">
            <p className="text-sm leading-snug">{log.message}</p>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {log.source}
              </span>
              {log.method && log.path && (
                <span className="text-xs text-muted-foreground font-mono">
                  {log.method} {log.path}
                </span>
              )}
              {log.statusCode != null && (
                <span className="text-xs text-muted-foreground">
                  {log.statusCode}
                </span>
              )}
              {log.durationMs != null && (
                <span className="text-xs text-muted-foreground">
                  {log.durationMs}ms
                </span>
              )}
              <RelativeTime date={log.createdAt} />
            </div>
          </div>
          {(log.errorStack || log.metadata) && (
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
        {expanded && (
          <pre className="mt-3 text-xs bg-muted rounded p-2 overflow-auto max-h-40 text-muted-foreground whitespace-pre-wrap">
            {log.errorStack ?? JSON.stringify(log.metadata, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

// ─── ActivitySkeletons ─────────────────────────────────────────────────────────

function LogSkeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i} className="shadow-none border-border/60">
          <CardContent className="py-3 px-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 mt-0.5 shrink-0 rounded" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── ActivityTab ───────────────────────────────────────────────────────────────

function ActivityTab({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const hasFilters = actionFilter !== "all" || search !== "";

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (actionFilter !== "all") {
    // Find all actions in the selected group
    const groupActions = ACTION_GROUPS[actionFilter];
    if (groupActions) {
      params.set("actions", groupActions.join(","));
    }
  }
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery<PaginatedActivity>({
    queryKey: ["activity-logs", workspaceId, page, actionFilter, search],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/logs/activity?${params.toString()}`,
      ).then((r) => r.json()),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  function resetFilters() {
    setActionFilter("all");
    setSearch("");
    setSearchInput("");
    setPage(1);
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
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
            {Object.keys(ACTION_GROUPS).map((group) => (
              <SelectItem key={group} value={group}>
                {group}
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
            className="w-56"
          />
          <Button type="submit" variant="outline" size="sm">
            Найти
          </Button>
        </form>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="text-muted-foreground"
          >
            <XCircle className="h-4 w-4 mr-1" />
            Сбросить
          </Button>
        )}
      </div>

      {/* Log list */}
      {isLoading ? (
        <LogSkeletons />
      ) : !data || data.data.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">Событий не найдено</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.data.map((log) => (
            <ActivityLogRow key={log.id} log={log} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-muted-foreground">
            {data.total} событий · страница {page} из {totalPages}
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

// ─── SystemTab ─────────────────────────────────────────────────────────────────

function SystemTab({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [levelFilter, setLevelFilter] = useState<string>("all");

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (levelFilter !== "all") params.set("level", levelFilter);

  const { data, isLoading } = useQuery<PaginatedSystem>({
    queryKey: ["system-logs", workspaceId, page, levelFilter],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/logs/system?${params.toString()}`,
      ).then((r) => r.json()),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={levelFilter}
          onValueChange={(v) => {
            setLevelFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Уровень" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все уровни</SelectItem>
            <SelectItem value="INFO">INFO</SelectItem>
            <SelectItem value="WARN">WARN</SelectItem>
            <SelectItem value="ERROR">ERROR</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Log list */}
      {isLoading ? (
        <LogSkeletons />
      ) : !data || data.data.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">Системных логов не найдено</p>
        </div>
      ) : (
        <div className="space-y-2">
          {data.data.map((log) => (
            <SystemLogRow key={log.id} log={log} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm text-muted-foreground">
            {data.total} записей · страница {page} из {totalPages}
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

// ─── LogsClient ────────────────────────────────────────────────────────────────

export function LogsClient({ workspaceId }: Props) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Логи активности</h1>

      <Tabs defaultValue="activity">
        <TabsList className="mb-6">
          <TabsTrigger value="activity">Активность команды</TabsTrigger>
          <TabsTrigger value="system">Системные логи</TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <ActivityTab workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent value="system">
          <SystemTab workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
