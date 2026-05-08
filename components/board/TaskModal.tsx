"use client";

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
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
import {
  Clock,
  Timer,
  ArrowRight,
  Trash2,
  Pencil,
  X,
  Check,
  Paperclip,
  Download,
  Upload,
  MessageSquare,
  Send,
  Eye,
  FileText,
} from "lucide-react";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { formatDuration } from "./TaskCard";
import type { ProjectBoard } from "@/lib/services/project.service";
import type { TaskFull } from "@/lib/services/task.service";

type Member = ProjectBoard["members"][0];

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

const priorityOptions = [
  { value: "NONE", label: "Без приоритета" },
  { value: "LOW", label: "Низкий" },
  { value: "MEDIUM", label: "Средний" },
  { value: "HIGH", label: "Высокий" },
  { value: "URGENT", label: "Срочный" },
] as const;

type Props = {
  taskId: string;
  projectId: string;
  members: Member[];
  onClose: () => void;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskModal({ taskId, projectId, members, onClose }: Props) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

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
  const [editAssigneeIds, setEditAssigneeIds] = useState<string[]>([]);
  const [editPriority, setEditPriority] = useState("NONE");
  const [liveMs, setLiveMs] = useState(0);

  useEffect(() => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDesc(task.description ?? "");
    setEditAssigneeIds(task.assignees.map((a) => a.id));
    setEditPriority(task.priority);
    setLiveMs(task.totalTimeMs);
  }, [task]);

  // Live timer
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

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
  };

  const updateMutation = useMutation({
    mutationFn: async (data: {
      title?: string;
      description?: string | null;
      assigneeIds?: string[];
      priority?: string;
    }) => {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw await res.json();
      return res.json();
    },
    onSuccess: invalidateAll,
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

  function handleSaveAndClose() {
    if (!task) {
      onClose();
      return;
    }
    const description = editDesc.trim() || null;
    const oldAssigneeIds = task.assignees
      .map((a) => a.id)
      .sort()
      .join(",");
    const newAssigneeIds = [...editAssigneeIds].sort().join(",");

    const hasChanges =
      editTitle !== task.title ||
      description !== task.description ||
      oldAssigneeIds !== newAssigneeIds ||
      editPriority !== task.priority;

    if (!hasChanges) {
      onClose();
      return;
    }

    updateMutation.mutate(
      {
        title: editTitle.trim() || task.title,
        description,
        assigneeIds: editAssigneeIds,
        priority: editPriority,
      },
      {
        onSuccess: () => {
          toastSuccess("Задача сохранена");
          onClose();
        },
      },
    );
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
                className="font-medium"
              />
            </div>

            {/* Description */}
            <div className="space-y-1">
              <Label>Описание</Label>
              <Textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={3}
                placeholder="Описание задачи..."
              />
            </div>

            {/* Priority */}
            <div className="space-y-1">
              <Label>Приоритет</Label>
              <select
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {priorityOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Assignees */}
            <div className="space-y-1">
              <Label>Исполнители</Label>
              <div className="rounded-md border border-input p-2 space-y-1 max-h-40 overflow-y-auto">
                {members.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={editAssigneeIds.includes(m.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setEditAssigneeIds((prev) => [...prev, m.id]);
                        } else {
                          setEditAssigneeIds((prev) =>
                            prev.filter((id) => id !== m.id),
                          );
                        }
                      }}
                      className="h-4 w-4 rounded border-input"
                    />
                    <span>{m.login}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.role === "OWNER" ? "(Владелец)" : "(Участник)"}
                    </span>
                  </label>
                ))}
              </div>
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

            {/* Comments section */}
            <CommentsSection
              taskId={taskId}
              comments={task.comments}
              currentUserId={currentUserId}
              onMutated={invalidateAll}
            />

            {/* Attachments section */}
            <AttachmentsSection
              taskId={taskId}
              attachments={task.attachments}
              currentUserId={currentUserId}
              members={members}
              onMutated={invalidateAll}
            />

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
              <Button
                size="sm"
                disabled={updateMutation.isPending}
                onClick={handleSaveAndClose}
              >
                {updateMutation.isPending ? "Сохранение..." : "Сохранить"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Comments ────────────────────────────────────────────────────────────────

function CommentsSection({
  taskId,
  comments,
  currentUserId,
  onMutated,
}: {
  taskId: string;
  comments: TaskFullResponse["comments"];
  currentUserId: string | undefined;
  onMutated: () => void;
}) {
  const [newText, setNewText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const addMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      setNewText("");
      onMutated();
    },
    onError: toastApiError,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      setEditingId(null);
      onMutated();
    },
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/comments/${id}`, { method: "DELETE" });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      toastSuccess("Комментарий удалён");
      onMutated();
    },
    onError: toastApiError,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newText.trim();
    if (!trimmed) return;
    addMutation.mutate(trimmed);
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        <MessageSquare className="h-3.5 w-3.5" />
        Комментарии ({comments.length})
      </p>

      {comments.length > 0 && (
        <div className="space-y-3 rounded-lg border p-3">
          {comments.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {c.author.login}
                </span>
                <span>{format(new Date(c.createdAt), "dd.MM.yyyy HH:mm")}</span>
                {c.updatedAt !== c.createdAt && (
                  <span className="italic">(ред.)</span>
                )}
                {currentUserId === c.author.id && editingId !== c.id && (
                  <span className="ml-auto flex gap-1">
                    <button
                      onClick={() => {
                        setEditingId(c.id);
                        setEditText(c.text);
                      }}
                      className="hover:text-foreground transition-colors"
                      title="Редактировать"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Удалить комментарий?"))
                          deleteMutation.mutate(c.id);
                      }}
                      className="hover:text-destructive transition-colors"
                      title="Удалить"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>

              {editingId === c.id ? (
                <div className="flex gap-2">
                  <Textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                    className="text-sm"
                  />
                  <div className="flex flex-col gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={updateMutation.isPending}
                      onClick={() => {
                        const trimmed = editText.trim();
                        if (!trimmed) return;
                        updateMutation.mutate({ id: c.id, text: trimmed });
                      }}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{c.text}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add comment form */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          placeholder="Написать комментарий..."
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          className="text-sm"
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          disabled={addMutation.isPending || !newText.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

// ─── Attachments ─────────────────────────────────────────────────────────────

function AttachmentsSection({
  taskId,
  attachments,
  currentUserId,
  members,
  onMutated,
}: {
  taskId: string;
  attachments: TaskFullResponse["attachments"];
  currentUserId: string | undefined;
  members: Member[];
  onMutated: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const isOwner = members.some(
    (m) => m.id === currentUserId && m.role === "OWNER",
  );

  const previewAttachment = previewId
    ? attachments.find((a) => a.id === previewId)
    : null;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/tasks/${taskId}/attachments`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      toastSuccess("Файл загружен");
      onMutated();
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err) => {
      toastApiError(err);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      toastSuccess("Файл удалён");
      onMutated();
    },
    onError: toastApiError,
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadMutation.mutate(file);
  }

  function canDelete(uploadedById: string): boolean {
    return uploadedById === currentUserId || isOwner;
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        <Paperclip className="h-3.5 w-3.5" />
        Вложения ({attachments.length})
      </p>

      {/* Inline preview */}
      {previewAttachment && (
        <div className="rounded-lg border bg-muted/30 p-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium truncate">
              {previewAttachment.originalName}
            </span>
            <button
              onClick={() => setPreviewId(null)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {isImage(previewAttachment.mimeType) ? (
            <div className="relative max-h-80 w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${previewAttachment.id}`}
                alt={previewAttachment.originalName}
                className="max-h-80 w-full object-contain rounded"
              />
            </div>
          ) : isPdf(previewAttachment.mimeType) ? (
            <iframe
              src={`/api/attachments/${previewAttachment.id}`}
              className="w-full h-80 rounded border-0"
              title={previewAttachment.originalName}
            />
          ) : (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
              Предпросмотр недоступен для этого типа файла
            </div>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          {attachments.map((a) => (
            <div key={a.id} className="space-y-1.5">
              {/* Image thumbnail */}
              {isImage(a.mimeType) && (
                <button
                  onClick={() => setPreviewId(previewId === a.id ? null : a.id)}
                  className="block w-full"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/attachments/${a.id}`}
                    alt={a.originalName}
                    className="max-h-32 rounded border object-contain cursor-pointer hover:opacity-80 transition-opacity"
                  />
                </button>
              )}
              <div className="flex items-center gap-2 text-sm">
                {isImage(a.mimeType) ? (
                  <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : isPdf(a.mimeType) ? (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate flex-1" title={a.originalName}>
                  {a.originalName}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatFileSize(a.size)}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {a.uploadedBy.login}
                </span>
                {canPreview(a.mimeType) && !isImage(a.mimeType) && (
                  <button
                    onClick={() =>
                      setPreviewId(previewId === a.id ? null : a.id)
                    }
                    className="hover:text-primary transition-colors shrink-0"
                    title="Просмотр"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                <a
                  href={`/api/attachments/${a.id}?download=1`}
                  download
                  className="hover:text-primary transition-colors shrink-0"
                  title="Скачать"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                {canDelete(a.uploadedBy.id) && (
                  <button
                    onClick={() => {
                      if (confirm("Удалить файл?")) deleteMutation.mutate(a.id);
                    }}
                    className="hover:text-destructive transition-colors shrink-0"
                    title="Удалить"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={uploadMutation.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1 h-4 w-4" />
          {uploadMutation.isPending ? "Загрузка..." : "Прикрепить файл"}
        </Button>
      </div>
    </div>
  );
}

// ─── Preview helpers ─────────────────────────────────────────────────────────

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isPdf(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

function canPreview(mimeType: string): boolean {
  return isImage(mimeType) || isPdf(mimeType);
}
