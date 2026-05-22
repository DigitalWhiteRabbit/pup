"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  ArrowLeft,
  Send,
  User,
  AlertTriangle,
  Clock,
  Loader2,
  Sparkles,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { trackAction } from "@/lib/services/action-tracker";
import type {
  TicketFull,
  TicketMessageView,
} from "@/lib/services/tickets/ticket.service";

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Открыт",
  IN_PROGRESS: "В работе",
  WAITING_CUSTOMER: "Ждёт клиента",
  RESOLVED: "Решён",
  CLOSED: "Закрыт",
};

const PRIORITY_LABELS: Record<string, string> = {
  LOW: "Низкий",
  MEDIUM: "Средний",
  HIGH: "Высокий",
  URGENT: "Срочный",
};

const CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL: "Финансы",
  TECHNICAL: "Техническое",
  GENERAL: "Общее",
  BUG: "Баг",
  FEATURE_REQUEST: "Фича",
};

// ─── Message bubble ──────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: TicketMessageView }) {
  if (msg.authorType === "SYSTEM") {
    return (
      <div className="flex justify-center my-3">
        <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  const isManager = msg.authorType === "MANAGER" || msg.authorType === "AGENT";

  return (
    <div className={`flex ${isManager ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[75%] rounded-lg px-4 py-2.5 ${isManager ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        <div
          className={`text-xs font-medium mb-1 ${isManager ? "text-primary-foreground/70" : "text-muted-foreground"}`}
        >
          {msg.authorName}
        </div>
        <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
        <div
          className={`text-xs mt-1 ${isManager ? "text-primary-foreground/50" : "text-muted-foreground"}`}
        >
          {format(new Date(msg.createdAt), "dd MMM HH:mm", { locale: ru })}
        </div>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string;
  ticketId: string;
  currentUserId: string;
};

type CannedItem = {
  id: string;
  shortCode: string;
  title: string;
  content: string;
};

export function TicketDetailClient({
  workspaceId,
  ticketId,
  currentUserId,
}: Props) {
  const qc = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [replyText, setReplyText] = useState("");
  const [showCanned, setShowCanned] = useState(false);
  const [cannedFilter, setCannedFilter] = useState("");

  // Загружаем шаблоны ответов
  const { data: cannedData } = useQuery<{ data: CannedItem[] }>({
    queryKey: ["canned-responses", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/canned-responses`);
      if (!r.ok) return { data: [] };
      return r.json();
    },
    staleTime: 60_000,
  });
  const cannedItems = cannedData?.data ?? [];

  // Фильтрованные шаблоны
  const filteredCanned = cannedFilter
    ? cannedItems.filter(
        (c) =>
          c.shortCode.includes(cannedFilter) ||
          c.title.toLowerCase().includes(cannedFilter.toLowerCase()),
      )
    : cannedItems;

  const { data: ticket, isLoading } = useQuery<TicketFull>({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const r = await fetch(`/api/tickets/${ticketId}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 10_000,
  });

  // Members for assignee select
  const { data: membersData } = useQuery<{
    data: Array<{ id: string; login: string }>;
  }>({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}`).then((r) => r.json()),
    staleTime: 60_000,
  });
  const members =
    (membersData as { members?: Array<{ id: string; login: string }> })
      ?.members ?? [];

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [ticket?.messages.length]);

  const statusMut = useMutation({
    mutationFn: (status: string) =>
      fetch(`/api/tickets/${ticketId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: (_res, status) => {
      trackAction(
        "tickets:status:change",
        `tickets:status:change`,
        `${ticketId} -> ${status}`,
      );
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toastSuccess("Статус обновлён");
    },
    onError: toastApiError,
  });

  const priorityMut = useMutation({
    mutationFn: (priority: string) =>
      fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toastSuccess("Приоритет обновлён");
    },
    onError: toastApiError,
  });

  const categoryMut = useMutation({
    mutationFn: (category: string) =>
      fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
    },
    onError: toastApiError,
  });

  const assignMut = useMutation({
    mutationFn: (assigneeId: string | null) =>
      fetch(`/api/tickets/${ticketId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      trackAction("tickets:assign", `tickets:assign`, ticketId);
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      toastSuccess("Назначение обновлено");
    },
    onError: toastApiError,
  });

  const replyMut = useMutation({
    mutationFn: (content: string) =>
      fetch(`/api/tickets/${ticketId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      trackAction("tickets:message:send", `tickets:message:send`, ticketId);
      void qc.invalidateQueries({ queryKey: ["ticket", ticketId] });
      setReplyText("");
    },
    onError: toastApiError,
  });

  if (isLoading || !ticket) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const isClosed = ticket.status === "CLOSED";

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground font-mono">
              #{ticket.number}
            </span>
            <h1 className="text-xl font-bold truncate">{ticket.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {ticket.source === "EXTERNAL" ? "Внешний" : "Внутренний"} ·{" "}
            {ticket.creatorName} ·{" "}
            {formatDistanceToNow(new Date(ticket.createdAt), {
              addSuffix: true,
              locale: ru,
            })}
          </p>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Sidebar */}
        <div className="w-56 shrink-0 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              Статус
            </label>
            <Select
              value={ticket.status}
              onValueChange={(v) => statusMut.mutate(v)}
              disabled={isClosed || statusMut.isPending}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              Приоритет
            </label>
            <Select
              value={ticket.priority}
              onValueChange={(v) => priorityMut.mutate(v)}
              disabled={priorityMut.isPending}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              Категория
            </label>
            <Select
              value={ticket.category}
              onValueChange={(v) => categoryMut.mutate(v)}
              disabled={categoryMut.isPending}
            >
              <SelectTrigger className="h-8">
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

          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              Назначен
            </label>
            <Select
              value={ticket.assignee?.id ?? "__none__"}
              onValueChange={(v) =>
                assignMut.mutate(v === "__none__" ? null : v)
              }
              disabled={assignMut.isPending}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Не назначен</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.login}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!ticket.assignee && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-7 text-xs w-full"
                onClick={() => assignMut.mutate(currentUserId)}
              >
                <User className="h-3 w-3 mr-1" />
                Назначить себя
              </Button>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              SLA
            </label>
            {ticket.slaBreached ? (
              <div className="flex items-center gap-1 text-red-600 text-sm font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                Просрочен
              </div>
            ) : ticket.slaDeadline ? (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {formatDistanceToNow(new Date(ticket.slaDeadline), {
                  addSuffix: true,
                  locale: ru,
                })}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>

          {ticket.customer && (
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
                Клиент
              </label>
              <div className="text-sm">
                {ticket.customer.name ?? ticket.customer.email}
              </div>
              <div className="text-xs text-muted-foreground">
                {ticket.customer.email}
              </div>
            </div>
          )}

          {/* Collaborators */}
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground mb-1 block">
              Участники
            </label>
            {ticket.collaborators && ticket.collaborators.length > 0 ? (
              <div className="space-y-1">
                {ticket.collaborators.map(
                  (c: {
                    id: string;
                    userId: string;
                    login: string;
                    role: string;
                  }) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between text-xs"
                    >
                      <span>
                        {c.login}{" "}
                        <span className="text-muted-foreground">
                          (
                          {c.role === "reviewer"
                            ? "ревьюер"
                            : c.role === "observer"
                              ? "наблюдатель"
                              : "исполнитель"}
                          )
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={async () => {
                          await fetch(
                            `/api/tickets/${ticketId}/collaborators/${c.userId}`,
                            { method: "DELETE" },
                          );
                          void qc.invalidateQueries({
                            queryKey: ["ticket", ticketId],
                          });
                        }}
                      >
                        <span className="text-xs text-destructive">✕</span>
                      </Button>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Нет</div>
            )}
            <Select
              value="__add__"
              onValueChange={async (userId) => {
                if (userId === "__add__") return;
                await fetch(`/api/tickets/${ticketId}/collaborators`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ userId, role: "collaborator" }),
                });
                void qc.invalidateQueries({
                  queryKey: ["ticket", ticketId],
                });
              }}
            >
              <SelectTrigger className="h-7 mt-1 text-xs">
                <SelectValue placeholder="+ Добавить участника" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__add__" disabled>
                  + Добавить участника
                </SelectItem>
                {members
                  .filter(
                    (m) =>
                      m.id !== ticket.assignee?.id &&
                      !(ticket.collaborators ?? []).some(
                        (c: { userId: string }) => c.userId === m.id,
                      ),
                  )
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.login}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {!isClosed && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-destructive"
              onClick={() => statusMut.mutate("CLOSED")}
              disabled={statusMut.isPending}
            >
              Закрыть тикет
            </Button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 border rounded-lg p-4 overflow-y-auto max-h-[60vh] mb-4">
            {ticket.messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Reply */}
          {!isClosed && (
            <div className="flex gap-2 relative">
              {/* Canned responses dropdown */}
              {showCanned && filteredCanned.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                  {filteredCanned.map((c) => (
                    <button
                      key={c.id}
                      className="w-full text-left px-3 py-2 hover:bg-accent/40 transition-colors border-b last:border-0"
                      onClick={() => {
                        setReplyText(c.content);
                        setShowCanned(false);
                        setCannedFilter("");
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">
                          /{c.shortCode}
                        </code>
                        <span className="text-xs font-medium">{c.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {c.content}
                      </p>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                className="flex-1 min-h-[80px] rounded-md border px-3 py-2 text-sm resize-y"
                placeholder="Написать ответ... (/ для шаблонов)"
                value={replyText}
                onChange={(e) => {
                  const val = e.target.value;
                  setReplyText(val);
                  // Показываем шаблоны при вводе /
                  if (val.startsWith("/")) {
                    setShowCanned(true);
                    setCannedFilter(val.slice(1));
                  } else {
                    setShowCanned(false);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowCanned(false);
                  }
                  if (e.key === "Enter" && !e.shiftKey && replyText.trim()) {
                    e.preventDefault();
                    replyMut.mutate(replyText.trim());
                  }
                }}
                onBlur={() => {
                  // Delay чтобы клик по dropdown успел сработать
                  setTimeout(() => setShowCanned(false), 200);
                }}
              />
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  disabled={!replyText.trim() || replyMut.isPending}
                  onClick={() => replyMut.mutate(replyText.trim())}
                >
                  {replyMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  disabled={!replyText.trim() || replyMut.isPending}
                  onClick={() => {
                    replyMut.mutate(replyText.trim());
                    statusMut.mutate("WAITING_CUSTOMER");
                  }}
                >
                  + Ждать
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  disabled={!replyText.trim() || replyMut.isPending}
                  onClick={() => {
                    replyMut.mutate(replyText.trim());
                    statusMut.mutate("RESOLVED");
                  }}
                >
                  + Решить
                </Button>
              </div>
            </div>
          )}
          {/* AI Copilot */}
          {!isClosed && (
            <div className="flex gap-1.5 mt-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 gap-1"
                onClick={async () => {
                  try {
                    const r = await fetch(
                      `/api/tickets/${ticketId}/ai/suggest`,
                      { method: "POST" },
                    );
                    if (!r.ok) {
                      const d = await r.json().catch(() => ({}));
                      toastApiError(
                        new Error(
                          (d as { error?: string }).error ?? "Ошибка AI",
                        ),
                      );
                      return;
                    }
                    const d = (await r.json()) as { suggestion: string };
                    setReplyText(d.suggestion);
                    toastSuccess("AI предложил ответ");
                  } catch {
                    toastApiError(new Error("Ошибка AI"));
                  }
                }}
              >
                <Sparkles className="h-3 w-3" />
                Предложить ответ
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 gap-1"
                onClick={async () => {
                  try {
                    const r = await fetch(
                      `/api/tickets/${ticketId}/ai/summarize`,
                      { method: "POST" },
                    );
                    if (!r.ok) {
                      const d = await r.json().catch(() => ({}));
                      toastApiError(
                        new Error(
                          (d as { error?: string }).error ?? "Ошибка AI",
                        ),
                      );
                      return;
                    }
                    const d = (await r.json()) as { summary: string };
                    toastSuccess(d.summary);
                  } catch {
                    toastApiError(new Error("Ошибка AI"));
                  }
                }}
              >
                <FileText className="h-3 w-3" />
                Суммировать
              </Button>
            </div>
          )}
          {isClosed && (
            <div className="text-center py-4 text-sm text-muted-foreground bg-muted rounded-lg">
              Тикет закрыт
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
