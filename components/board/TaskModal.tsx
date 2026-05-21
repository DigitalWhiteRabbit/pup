"use client";

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { format, parse } from "date-fns";
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
  Plus,
  Tag,
  Calendar,
  CheckSquare,
  Square,
} from "lucide-react";
import { Calendar as CalendarWidget } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { formatFileSize } from "@/lib/utils";
import { formatDuration } from "./TaskCard";
import type { WorkspaceBoard } from "@/lib/services/workspace.service";
import type { TaskFull } from "@/lib/services/task.service";

type Member = WorkspaceBoard["members"][0];

type TaskFullResponse = Omit<
  TaskFull,
  | "createdAt"
  | "lastIntervalStartedAt"
  | "startDate"
  | "dueDate"
  | "comments"
  | "attachments"
  | "moveHistory"
> & {
  createdAt: string;
  lastIntervalStartedAt: string | null;
  startDate: string | null;
  dueDate: string | null;
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

type LabelData = { id: string; name: string; color: string };

const priorityOptions = [
  { value: "NONE", label: "Без приоритета" },
  { value: "LOW", label: "Низкий" },
  { value: "MEDIUM", label: "Средний" },
  { value: "HIGH", label: "Высокий" },
  { value: "URGENT", label: "Срочный" },
] as const;

const defaultLabelColors = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

type Props = {
  taskId: string;
  workspaceId: string;
  members: Member[];
  onClose: () => void;
};

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function TaskModal({ taskId, workspaceId, members, onClose }: Props) {
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
    refetchInterval: 5000,
  });

  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAssigneeIds, setEditAssigneeIds] = useState<string[]>([]);
  const [editPriority, setEditPriority] = useState("NONE");
  const [editStartDate, setEditStartDate] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editLabelIds, setEditLabelIds] = useState<string[]>([]);
  const [liveMs, setLiveMs] = useState(0);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);

  // Populate edit fields only on first load per task (not on refetch after checklist/comment)
  useEffect(() => {
    if (!task || initializedFor === taskId) return;
    setEditTitle(task.title);
    setEditDesc(task.description ?? "");
    setEditAssigneeIds(task.assignees.map((a) => a.id));
    setEditPriority(task.priority);
    setEditStartDate(toDateInputValue(task.startDate));
    setEditDueDate(toDateInputValue(task.dueDate));
    setEditLabelIds(task.labels.map((l) => l.id));
    setLiveMs(task.totalTimeMs);
    setInitializedFor(taskId);
  }, [task, initializedFor, taskId]);

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
    void queryClient.invalidateQueries({
      queryKey: ["workspace", workspaceId],
    });
  };

  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
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
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
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
    const oldAssignees = task.assignees
      .map((a) => a.id)
      .sort()
      .join(",");
    const newAssignees = [...editAssigneeIds].sort().join(",");
    const oldLabels = task.labels
      .map((l) => l.id)
      .sort()
      .join(",");
    const newLabels = [...editLabelIds].sort().join(",");

    const hasChanges =
      editTitle !== task.title ||
      description !== task.description ||
      oldAssignees !== newAssignees ||
      editPriority !== task.priority ||
      editStartDate !== toDateInputValue(task.startDate) ||
      editDueDate !== toDateInputValue(task.dueDate) ||
      oldLabels !== newLabels;

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
        startDate: editStartDate || null,
        dueDate: editDueDate || null,
        labelIds: editLabelIds,
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

            {/* Priority + Dates row */}
            <div className="grid grid-cols-3 gap-3 items-end">
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
              <div className="space-y-1">
                <Label className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Начало
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal h-9"
                    >
                      {editStartDate
                        ? format(
                            parse(editStartDate, "yyyy-MM-dd", new Date()),
                            "dd.MM.yyyy",
                          )
                        : "дд.мм.гггг"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarWidget
                      mode="single"
                      selected={
                        editStartDate
                          ? parse(editStartDate, "yyyy-MM-dd", new Date())
                          : undefined
                      }
                      onSelect={(date) =>
                        setEditStartDate(date ? format(date, "yyyy-MM-dd") : "")
                      }
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Дедлайн
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-start text-left font-normal h-9"
                    >
                      {editDueDate
                        ? format(
                            parse(editDueDate, "yyyy-MM-dd", new Date()),
                            "dd.MM.yyyy",
                          )
                        : "дд.мм.гггг"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarWidget
                      mode="single"
                      selected={
                        editDueDate
                          ? parse(editDueDate, "yyyy-MM-dd", new Date())
                          : undefined
                      }
                      onSelect={(date) =>
                        setEditDueDate(date ? format(date, "yyyy-MM-dd") : "")
                      }
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Assignees */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Исполнители</Label>
                {members.filter((m) => !editAssigneeIds.includes(m.id)).length >
                  0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1 h-6 text-xs"
                      >
                        <Plus className="h-3 w-3" />
                        Добавить
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-56 p-1" align="end">
                      {members
                        .filter((m) => !editAssigneeIds.includes(m.id))
                        .map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setEditAssigneeIds((p) => [...p, m.id])
                            }
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                          >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium">
                              {m.login.slice(0, 2).toUpperCase()}
                            </span>
                            {m.login}
                          </button>
                        ))}
                    </PopoverContent>
                  </Popover>
                )}
              </div>
              {editAssigneeIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {editAssigneeIds.map((uid) => {
                    const m = members.find((x) => x.id === uid);
                    if (!m) return null;
                    return (
                      <span
                        key={uid}
                        className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary pl-1 pr-1.5 py-0.5 text-sm"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                          {m.login.slice(0, 2).toUpperCase()}
                        </span>
                        {m.login}
                        <button
                          type="button"
                          onClick={() =>
                            setEditAssigneeIds((p) =>
                              p.filter((id) => id !== uid),
                            )
                          }
                          className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Labels */}
            <LabelsSection
              workspaceId={workspaceId}
              selectedIds={editLabelIds}
              taskLabels={task.labels}
              onChange={setEditLabelIds}
            />

            {/* Checklist */}
            <ChecklistSection
              taskId={taskId}
              items={task.checklistItems}
              onMutated={invalidateAll}
            />

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
              {task.createdBy && (
                <>
                  {" · "}Автор:{" "}
                  <span className="font-medium text-foreground">
                    {task.createdBy.login}
                  </span>
                </>
              )}
            </div>

            {/* Move history */}
            {task.moveHistory.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  История перемещений
                </p>
                <div className="space-y-1.5 rounded-lg border p-3">
                  {task.moveHistory.map((log) => (
                    <div
                      key={`${log.movedAt}-${log.fromColumnName}`}
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

            {/* Comments */}
            <CommentsSection
              taskId={taskId}
              comments={task.comments}
              currentUserId={currentUserId}
              onMutated={invalidateAll}
            />

            {/* Attachments */}
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

// ─── Labels ──────────────────────────────────────────────────────────────────

function LabelsSection({
  workspaceId,
  selectedIds,
  taskLabels,
  onChange,
}: {
  workspaceId: string;
  selectedIds: string[];
  taskLabels: LabelData[];
  onChange: (ids: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [showManager, setShowManager] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(defaultLabelColors[0]);

  const { data: allLabels = [] } = useQuery({
    queryKey: ["labels", workspaceId],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/labels`);
      if (!res.ok) return taskLabels;
      return res.json() as Promise<LabelData[]>;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      if (!res.ok) throw await res.json();
      return res.json() as Promise<LabelData>;
    },
    onSuccess: (label) => {
      void queryClient.invalidateQueries({ queryKey: ["labels", workspaceId] });
      onChange([...selectedIds, label.id]);
      setNewName("");
      toastSuccess("Метка создана");
    },
    onError: toastApiError,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1">
          <Tag className="h-3.5 w-3.5" />
          Метки
        </Label>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setShowManager(!showManager)}
        >
          {showManager ? "Скрыть" : "Управление"}
        </Button>
      </div>

      {/* Selected labels display */}
      <div className="flex flex-wrap gap-1.5">
        {allLabels
          .filter((l) => selectedIds.includes(l.id))
          .map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
              style={{ backgroundColor: l.color }}
            >
              {l.name}
              <button
                onClick={() =>
                  onChange(selectedIds.filter((id) => id !== l.id))
                }
                className="hover:opacity-70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
      </div>

      {showManager && (
        <div className="rounded-md border p-2 space-y-2">
          {/* Existing labels */}
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {allLabels.map((l) => (
              <label
                key={l.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent cursor-pointer"
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedIds.includes(l.id) ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"}`}
                  aria-hidden="true"
                >
                  {selectedIds.includes(l.id) && <Check className="h-3 w-3" />}
                </span>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(l.id)}
                  onChange={(e) => {
                    if (e.target.checked) onChange([...selectedIds, l.id]);
                    else onChange(selectedIds.filter((id) => id !== l.id));
                  }}
                  className="sr-only"
                />
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: l.color }}
                />
                <span>{l.name}</span>
              </label>
            ))}
          </div>
          {/* Create new */}
          <div className="flex gap-2 items-end border-t pt-2">
            <Input
              placeholder="Новая метка..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="text-sm h-8"
            />
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              aria-label="Цвет метки"
              className="h-8 w-8 rounded border cursor-pointer shrink-0"
            />
            <Button
              size="sm"
              className="h-8"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Checklist ───────────────────────────────────────────────────────────────

function ChecklistSection({
  taskId,
  items,
  onMutated,
}: {
  taskId: string;
  items: Array<{
    id: string;
    text: string;
    checked: boolean;
    position: number;
  }>;
  onMutated: () => void;
}) {
  const [newText, setNewText] = useState("");
  const doneCount = items.filter((i) => i.checked).length;

  const addMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/tasks/${taskId}/checklist`, {
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

  const toggleMutation = useMutation({
    mutationFn: async ({ id, checked }: { id: string; checked: boolean }) => {
      const res = await fetch(`/api/checklist/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked }),
      });
      if (!res.ok) throw await res.json();
    },
    onSuccess: onMutated,
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/checklist/${id}`, { method: "DELETE" });
      if (!res.ok) throw await res.json();
    },
    onSuccess: onMutated,
    onError: toastApiError,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1">
          <CheckSquare className="h-3.5 w-3.5" />
          Чек-лист {items.length > 0 && `(${doneCount}/${items.length})`}
        </Label>
      </div>

      {/* Progress bar */}
      {items.length > 0 && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300 rounded-full"
            style={{ width: `${(doneCount / items.length) * 100}%` }}
          />
        </div>
      )}

      {/* Items */}
      {items.length > 0 && (
        <div className="space-y-1 rounded-lg border p-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 group">
              <button
                onClick={() =>
                  toggleMutation.mutate({ id: item.id, checked: !item.checked })
                }
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {item.checked ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </button>
              <span
                className={`text-sm flex-1 ${item.checked ? "line-through text-muted-foreground" : ""}`}
              >
                {item.text}
              </span>
              <button
                onClick={() => deleteMutation.mutate(item.id)}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add item */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = newText.trim();
          if (t) addMutation.mutate(t);
        }}
        className="flex gap-2"
      >
        <Input
          placeholder="Добавить пункт..."
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
          <Plus className="h-4 w-4" />
        </Button>
      </form>
    </div>
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

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        <MessageSquare className="h-3.5 w-3.5" /> Комментарии ({comments.length}
        )
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
                        const t = editText.trim();
                        if (t) updateMutation.mutate({ id: c.id, text: t });
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = newText.trim();
          if (t) addMutation.mutate(t);
        }}
        className="flex gap-2"
      >
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

  const canDelete = (uploadedById: string) =>
    uploadedById === currentUserId || isOwner;

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        <Paperclip className="h-3.5 w-3.5" /> Вложения ({attachments.length})
      </p>
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
              Предпросмотр недоступен
            </div>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="space-y-2 rounded-lg border p-3">
          {attachments.map((a) => (
            <div key={a.id} className="space-y-1.5">
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
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadMutation.mutate(f);
          }}
          className="hidden"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={uploadMutation.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1 h-4 w-4" />{" "}
          {uploadMutation.isPending ? "Загрузка..." : "Прикрепить файл"}
        </Button>
      </div>
    </div>
  );
}

// ─── Preview helpers ─────────────────────────────────────────────────────────

function isImage(mimeType: string) {
  return mimeType.startsWith("image/");
}
function isPdf(mimeType: string) {
  return mimeType === "application/pdf";
}
function canPreview(mimeType: string) {
  return isImage(mimeType) || isPdf(mimeType);
}
