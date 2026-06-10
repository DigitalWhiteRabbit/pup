"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Bell,
  UserPlus,
  MessageSquare,
  ArrowRightLeft,
  FolderPlus,
  ClipboardCheck,
  Undo2,
  CheckCircle2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type NotificationItem = {
  id: string;
  type:
    | "ASSIGNED"
    | "COMMENTED"
    | "MOVED"
    | "PROJECT_ADDED"
    | "CONTENT_REVIEW"
    | "CONTENT_CHANGES"
    | "CONTENT_APPROVED";
  taskId: string | null;
  taskTitle: string | null;
  cardId: string | null;
  cardTitle: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  projectName: string | null;
  actorLogin: string | null;
  isRead: boolean;
  createdAt: string;
};

const TYPE_CONFIG = {
  ASSIGNED: { icon: UserPlus, label: "назначил вас на задачу" },
  COMMENTED: { icon: MessageSquare, label: "прокомментировал задачу" },
  MOVED: { icon: ArrowRightLeft, label: "переместил задачу" },
  PROJECT_ADDED: { icon: FolderPlus, label: "добавил вас в проект" },
  CONTENT_REVIEW: {
    icon: ClipboardCheck,
    label: "отправил карточку на вычитку",
  },
  CONTENT_CHANGES: { icon: Undo2, label: "вернул карточку на правки" },
  CONTENT_APPROVED: { icon: CheckCircle2, label: "одобрил карточку" },
} as const;

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: countData } = useQuery<{ count: number }>({
    queryKey: ["notifications", "unread-count"],
    queryFn: () =>
      fetch("/api/notifications/unread-count").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const { data: listData } = useQuery<{
    data: NotificationItem[];
    total: number;
    unreadCount: number;
  }>({
    queryKey: ["notifications", "list"],
    queryFn: () => fetch("/api/notifications?limit=10").then((r) => r.json()),
    enabled: open,
  });

  const markAllRead = useMutation({
    mutationFn: () =>
      fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const unreadCount = countData?.count ?? 0;
  const notifications = listData?.data ?? [];

  function handleClick(n: NotificationItem) {
    setOpen(false);
    if (n.cardId && n.workspaceId) {
      router.push(`/workspaces/${n.workspaceId}/content`);
    } else if (n.taskId && n.workspaceId) {
      router.push(`/workspaces/${n.workspaceId}/crm?taskId=${n.taskId}`);
    } else if (n.workspaceId) {
      router.push(`/workspaces/${n.workspaceId}/crm`);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-xs font-bold text-destructive-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          <span className="sr-only">Уведомления</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Уведомления</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs"
              onClick={() => markAllRead.mutate()}
            >
              Прочитать все
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Нет новых уведомлений
            </p>
          ) : (
            notifications.map((n) => {
              const config = TYPE_CONFIG[n.type];
              const Icon = config.icon;
              return (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
                    !n.isRead && "bg-accent/50",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">
                        {n.actorLogin ?? "System"}
                      </span>{" "}
                      {config.label}
                      {n.taskTitle && (
                        <>
                          {" "}
                          <span className="font-medium">{n.taskTitle}</span>
                        </>
                      )}
                      {n.type === "PROJECT_ADDED" && n.projectName && (
                        <>
                          {" "}
                          <span className="font-medium">{n.projectName}</span>
                        </>
                      )}
                      {n.cardTitle && (
                        <>
                          {" "}
                          <span className="font-medium">{n.cardTitle}</span>
                        </>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(n.createdAt), {
                        addSuffix: true,
                        locale: ru,
                      })}
                    </p>
                  </div>
                  {!n.isRead && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
