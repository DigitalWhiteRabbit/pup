"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, Timer, ArrowRight, Trash2 } from "lucide-react";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { formatDuration } from "./TaskCard";
import type { ProjectBoard } from "@/lib/services/project.service";
import type { TaskFull } from "@/lib/services/task.service";

type Member = ProjectBoard["members"][0];

// API response has ISO strings instead of Date objects
type TaskFullResponse = Omit<
  TaskFull,
  | "createdAt"
  | "lastIntervalStartedAt"
  | "comments"
  | "attachments"
  | "moveHistory"
> & {
  createdAt: string;
  lastIntervalStartedAt: string | null;
  comments: Array<{
    id: string;
    text: string;
    author: { id: string; login: string };
    createdAt: string;
    updatedAt: string;
  }>;
  attachments: Array<{
    id: string;
    originalName: string;
    size: number;
    mimeType: string;
    uploadedBy: { id: string; login: string };
    uploadedAt: string;
  }>;
  moveHistory: Array<{
    fromColumnName: string;
    toColumnName: string;
    movedBy: { id: string; login: string };
    movedAt: string;
  }>;
};

type Props = {
  taskId: string;
  projectId: string;
  members: Member[];
  onClose: () => void;
};

export function TaskModal({ taskId, projectId, members, onClose }: Props) {
  const queryClient = useQueryClient();

  const { data: task, isLoading } = useQuery({
    queryKey: ["task", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) throw new Error("Не удалось загрузить задачу");
      return res.json() as Promise<TaskFullResponse>;
    },
  });

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAssignee, setEditAssignee] = useState<string>("");
  const [liveMs, setLiveMs] = useState(0);

  useEffect(() => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDesc(task.description ?? "");
    setEditAssignee(task.assignee?.id ?? "");
    setLiveMs(task.totalTimeMs);
  }, [task]);

  // Live timer inside modal — capture stable values to avoid stale closure
  useEffect(() => {
    if (!task?.isInProgress || !task.lastIntervalStartedAt) return;
    const startedAt = new Date(task.lastIntervalStartedAt).getTime();
    const baseMs = task.totalTimeMs;

    function tick() {
      setLiveMs(baseMs + (Date.now() - startedAt));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [task?.isInProgress, task?.totalTimeMs, task?.lastIntervalStartedAt]);

  const updateMutation = useMutation({
    mutationFn: async (data: {
      title?: string;
      description?: string | null;
      assigneeId?: string | null;
    }) => {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw await res.json();
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      toastSuccess("Задача удалена");
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      onClose();
    },
    onError: toastApiError,
  });

  function handleSave() {
    if (!task) return;
    const assigneeId = editAssignee || null;
    const description = editDesc.trim() || null;

    const hasChanges =
      editTitle !== task.title ||
      description !== task.description ||
      assigneeId !== (task.assignee?.id ?? null);

    if (!hasChanges) return;

    updateMutation.mutate({
      title: editTitle.trim() || task.title,
      description,
      assigneeId,
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Карточка задачи</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-6 w-32" />
          </div>
        )}

        {task && (
          <div className="space-y-5">
            {/* Title */}
            <div className="space-y-1">
              <Label>Название</Label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleSave}
                className="font-medium"
              />
            </div>

            {/* Description */}
            <div className="space-y-1">
              <Label>Описание</Label>
              <Textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                onBlur={handleSave}
                rows={3}
                placeholder="Описание задачи..."
              />
            </div>

            {/* Assignee */}
            <div className="space-y-1">
              <Label>Исполнитель</Label>
              <select
                value={editAssignee}
                onChange={(e) => setEditAssignee(e.target.value)}
                onBlur={handleSave}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Не назначен —</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.login} {m.role === "OWNER" ? "(Владелец)" : "(Участник)"}
                  </option>
                ))}
              </select>
            </div>

            {/* Time info */}
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
              {task.isInProgress ? (
                <>
                  <Timer className="h-4 w-4 text-primary animate-pulse" />
                  <span className="text-sm font-medium text-primary">
                    В работе
                  </span>
                  <Badge variant="default" className="font-mono text-xs">
                    {formatDuration(liveMs)}
                  </Badge>
                </>
              ) : (
                <>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    Время в работе:
                  </span>
                  <span className="text-sm font-mono">
                    {task.totalTimeMs > 0
                      ? formatDuration(task.totalTimeMs)
                      : "—"}
                  </span>
                </>
              )}
            </div>

            {/* Column info */}
            <div className="text-xs text-muted-foreground">
              Колонка:{" "}
              <span className="font-medium text-foreground">
                {task.columnName}
              </span>
              {" · "}Создана:{" "}
              {format(new Date(task.createdAt), "dd.MM.yyyy HH:mm")}
            </div>

            {/* Move history */}
            {task.moveHistory.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  История перемещений
                </p>
                <div className="space-y-1.5 rounded-lg border p-3">
                  {task.moveHistory.map((log, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {log.movedBy.login}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {log.fromColumnName}
                        </span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {log.toColumnName}
                        </span>
                      </span>
                      <span className="ml-auto shrink-0">
                        {format(new Date(log.movedAt), "HH:mm dd.MM")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments/Attachments placeholder */}
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              Комментарии и вложения — Phase 7 (US5)
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t pt-4">
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirm("Удалить задачу?")) deleteMutation.mutate();
                }}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                {deleteMutation.isPending ? "Удаление..." : "Удалить"}
              </Button>
              <Button variant="outline" size="sm" onClick={onClose}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
