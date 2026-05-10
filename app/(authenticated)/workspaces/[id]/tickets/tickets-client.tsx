"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Plus,
  Search,
  Settings,
  Ticket,
  AlertTriangle,
  MessageSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type { TicketSummary } from "@/lib/services/tickets/ticket.service";

type ListResult = {
  data: TicketSummary[];
  total: number;
  counters: Record<string, number>;
};

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "bg-gray-100 text-gray-700",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Открыт",
  IN_PROGRESS: "В работе",
  WAITING_CUSTOMER: "Ждёт клиента",
  RESOLVED: "Решён",
  CLOSED: "Закрыт",
};

const CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL: "Финансы",
  TECHNICAL: "Техническое",
  GENERAL: "Общее",
  BUG: "Баг",
  FEATURE_REQUEST: "Фича",
};

function SlaIndicator({
  deadline,
  breached,
}: {
  deadline: string | null;
  breached: boolean;
}) {
  if (!deadline)
    return <span className="text-xs text-muted-foreground">—</span>;
  if (breached) {
    return (
      <span className="text-xs text-red-600 font-medium flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" />
        Просрочен
      </span>
    );
  }
  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();
  const urgencyClass =
    diff < 15 * 60 * 1000
      ? "text-red-600"
      : diff < 60 * 60 * 1000
        ? "text-orange-600"
        : "text-muted-foreground";
  return (
    <span className={`text-xs ${urgencyClass}`}>
      {formatDistanceToNow(d, { addSuffix: true, locale: ru })}
    </span>
  );
}

// ─── Create Dialog ───────────────────────────────────────────────────────────

function CreateTicketDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("GENERAL");
  const [priority, setPriority] = useState("MEDIUM");

  const createMut = useMutation({
    mutationFn: (data: {
      title: string;
      description: string;
      category: string;
      priority: string;
    }) =>
      fetch(`/api/workspaces/${workspaceId}/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, source: "INTERNAL" }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets", workspaceId] });
      toastSuccess("Тикет создан");
      setTitle("");
      setDescription("");
      setCategory("GENERAL");
      setPriority("MEDIUM");
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Создать тикет</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <label className="text-sm font-medium mb-1 block">Заголовок</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Кратко опишите проблему"
              maxLength={200}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Описание</label>
            <textarea
              className="w-full min-h-[120px] rounded-md border px-3 py-2 text-sm resize-y"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Подробности..."
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-sm font-medium mb-1 block">
                Категория
              </label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium mb-1 block">
                Приоритет
              </label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Низкий (72ч)</SelectItem>
                  <SelectItem value="MEDIUM">Средний (24ч)</SelectItem>
                  <SelectItem value="HIGH">Высокий (4ч)</SelectItem>
                  <SelectItem value="URGENT">Срочный (1ч)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            className="w-full"
            disabled={
              !title.trim() || !description.trim() || createMut.isPending
            }
            onClick={() =>
              createMut.mutate({
                title: title.trim(),
                description: description.trim(),
                category,
                priority,
              })
            }
          >
            {createMut.isPending ? "Создание..." : "Создать"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main client ─────────────────────────────────────────────────────────────

export function TicketsClient({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortBy, setSortBy] = useState("updatedAt");
  const [createOpen, setCreateOpen] = useState(false);

  const params = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    sortBy,
    sortOrder: "desc",
  });
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery<ListResult>({
    queryKey: ["tickets", workspaceId, page, statusFilter, search, sortBy],
    queryFn: async () => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/tickets?${params.toString()}`,
      );
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const counters = data?.counters ?? {};
  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  const tabs = [
    {
      key: "all",
      label: "Все",
      count: Object.values(counters).reduce((a: number, b: number) => a + b, 0),
    },
    { key: "OPEN", label: "Открытые", count: counters["OPEN"] ?? 0 },
    {
      key: "IN_PROGRESS",
      label: "В работе",
      count: counters["IN_PROGRESS"] ?? 0,
    },
    {
      key: "WAITING_CUSTOMER",
      label: "Ждут клиента",
      count: counters["WAITING_CUSTOMER"] ?? 0,
    },
    { key: "RESOLVED", label: "Решённые", count: counters["RESOLVED"] ?? 0 },
    { key: "CLOSED", label: "Закрытые", count: counters["CLOSED"] ?? 0 },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Тикеты</h1>
          <p className="text-sm text-muted-foreground">
            Обращения и задачи поддержки
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/workspaces/${workspaceId}/tickets/customers`}>
            <Button variant="outline" size="sm">
              Клиенты
            </Button>
          </Link>
          <Link href={`/workspaces/${workspaceId}/tickets/settings`}>
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-1.5" />
              Настройки чата
            </Button>
          </Link>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Создать тикет
          </Button>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-4 border-b overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              statusFilter === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => {
              setStatusFilter(t.key);
              setPage(1);
            }}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchInput.trim());
            setPage(1);
          }}
        >
          <Input
            placeholder="Поиск по тикетам..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-52 h-8"
          />
          <Button type="submit" variant="outline" size="sm" className="h-8">
            <Search className="h-3.5 w-3.5" />
          </Button>
        </form>
        <Select
          value={sortBy}
          onValueChange={(v) => {
            setSortBy(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updatedAt">По обновлению</SelectItem>
            <SelectItem value="createdAt">По созданию</SelectItem>
            <SelectItem value="priority">По приоритету</SelectItem>
            <SelectItem value="slaDeadline">По SLA</SelectItem>
          </SelectContent>
        </Select>
        {search && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={() => {
              setSearch("");
              setSearchInput("");
            }}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Сбросить
          </Button>
        )}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : !data || data.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Ticket className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground mb-4">Тикетов пока нет</p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Создать первый тикет
          </Button>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Приоритет</th>
                <th className="px-3 py-2 font-medium">Заголовок</th>
                <th className="px-3 py-2 font-medium">Категория</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Назначен</th>
                <th className="px-3 py-2 font-medium">SLA</th>
                <th className="px-3 py-2 font-medium text-center">
                  <MessageSquare className="h-3.5 w-3.5 inline" />
                </th>
                <th className="px-3 py-2 font-medium">Обновлён</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((t) => (
                <tr
                  key={t.id}
                  className="border-t hover:bg-accent/40 transition-colors"
                >
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {t.number}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge
                      variant="secondary"
                      className={`text-[10px] ${PRIORITY_COLORS[t.priority] ?? ""}`}
                    >
                      {t.priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/workspaces/${workspaceId}/tickets/${t.id}`}
                      className="hover:underline font-medium"
                    >
                      {t.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {t.creatorName}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="outline" className="text-[10px]">
                      {CATEGORY_LABELS[t.category] ?? t.category}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="outline" className="text-[10px]">
                      {STATUS_LABELS[t.status] ?? t.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.assignee?.login ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <SlaIndicator
                      deadline={t.slaDeadline as unknown as string}
                      breached={t.slaBreached}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">
                    {t.messagesCount}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(t.updatedAt), {
                      addSuffix: true,
                      locale: ru,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-6">
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

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
