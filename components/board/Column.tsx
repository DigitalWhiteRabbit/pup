"use client";

import { useState, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TaskCard } from "./TaskCard";
import { TaskModal } from "./TaskModal";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { toastError } from "@/lib/toast";
import { trackAction } from "@/lib/services/action-tracker";
import type { WorkspaceBoard } from "@/lib/services/workspace.service";

type ColumnData = WorkspaceBoard["columns"][0];
type Member = WorkspaceBoard["members"][0];

type Props = {
  column: ColumnData;
  workspaceId: string;
  members: Member[];
};

export function Column({ column, workspaceId, members }: Props) {
  const queryClient = useQueryClient();

  // ─── Sortable (column drag) ────────────────────────────────────────────────
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: { type: "column" },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // ─── Rename ────────────────────────────────────────────────────────────────
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(column.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const renameMutation = useMutation({
    mutationFn: async (newName: string) => {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw await res.json();
      return res.json() as Promise<{ id: string; name: string }>;
    },
    onMutate: async (newName) => {
      await queryClient.cancelQueries({ queryKey: ["workspace", workspaceId] });
      const previous = queryClient.getQueryData<WorkspaceBoard>([
        "workspace",
        workspaceId,
      ]);
      queryClient.setQueryData<WorkspaceBoard>(
        ["workspace", workspaceId],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            columns: old.columns.map((c) =>
              c.id === column.id ? { ...c, name: newName } : c,
            ),
          };
        },
      );
      return { previous };
    },
    onError: (_err, _newName, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["workspace", workspaceId], context.previous);
      }
      toastError("Не удалось переименовать колонку");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    },
  });

  function startRename() {
    setRenameValue(column.name);
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    setIsRenaming(false);
    if (!trimmed || trimmed === column.name) return;
    trackAction(
      "crm:column:rename",
      `crm:column:rename`,
      `${column.name} -> ${trimmed}`,
    );
    renameMutation.mutate(trimmed);
  }

  // ─── Delete ────────────────────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/columns/${column.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      trackAction("crm:column:delete", `crm:column:delete`, column.name);
      toastSuccess("Колонка удалена");
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    },
    onError: toastApiError,
  });

  // ─── Add task ──────────────────────────────────────────────────────────────
  const [showAddTask, setShowAddTask] = useState(false);
  const [addAtTop, setAddAtTop] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingTask, setAddingTask] = useState(false);

  async function handleAddTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    setAddingTask(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, columnId: column.id }),
      });
      if (!res.ok) throw await res.json();
      trackAction("crm:task:create", `crm:task:create`, title);
      setNewTaskTitle("");
      setShowAddTask(false);
      setAddAtTop(false);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    } catch (err) {
      toastApiError(err);
    } finally {
      setAddingTask(false);
    }
  }

  // ─── Task modal ────────────────────────────────────────────────────────────
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // ─── Render ────────────────────────────────────────────────────────────────
  const sortedTasks = [...column.tasks].sort((a, b) => a.position - b.position);
  const hasTasks = column.tasks.length > 0;

  const cancelAddTask = () => {
    setShowAddTask(false);
    setAddAtTop(false);
    setNewTaskTitle("");
  };

  const addTaskForm = (
    <div className="space-y-1.5">
      <Input
        value={newTaskTitle}
        onChange={(e) => setNewTaskTitle(e.target.value)}
        placeholder="Название задачи"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleAddTask();
          if (e.key === "Escape") cancelAddTask();
        }}
        className="h-8 text-sm"
      />
      <div className="flex gap-1">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => void handleAddTask()}
          disabled={addingTask || !newTaskTitle.trim()}
        >
          {addingTask ? "..." : "Добавить"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={cancelAddTask}
        >
          Отмена
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`flex-shrink-0 w-[260px] md:w-72 flex flex-col rounded-lg border bg-muted/20 ${
          isDragging ? "opacity-40 ring-2 ring-primary" : ""
        }`}
      >
        {/* ── Column header ── */}
        <div className="flex items-center gap-1 p-3 border-b">
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
            title="Переместить колонку"
            aria-label={`Перетащить колонку: ${column.name}`}
          >
            <GripVertical className="h-4 w-4" />
          </button>

          {isRenaming ? (
            <div className="flex-1 flex items-center gap-1">
              <Input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setIsRenaming(false);
                }}
                onBlur={commitRename}
                className="h-7 text-sm font-semibold px-2"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                aria-label="Подтвердить переименование"
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent onBlur firing before click
                  commitRename();
                }}
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                aria-label="Отменить переименование"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsRenaming(false);
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <div className="flex-1 flex items-center gap-1 min-w-0">
              <span className="flex-1 text-sm font-semibold truncate">
                {column.name}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {column.tasks.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  setAddAtTop(true);
                  setShowAddTask(true);
                }}
                title="Добавить задачу"
                aria-label="Добавить задачу"
              >
                <Plus className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={startRename}
                title="Переименовать"
                aria-label="Переименовать колонку"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                disabled={hasTasks || deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
                title={
                  hasTasks
                    ? "Сначала переместите все задачи из колонки"
                    : "Удалить колонку"
                }
                aria-label={
                  hasTasks
                    ? "Сначала переместите все задачи из колонки"
                    : "Удалить колонку"
                }
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* ── Add task (from header, appears at top) ── */}
        {showAddTask && addAtTop && (
          <div className="p-2 border-b">{addTaskForm}</div>
        )}

        {/* ── Task list ── */}
        <SortableContext
          items={sortedTasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex-1 flex flex-col gap-2 p-2 min-h-[60px]">
            {sortedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                columnId={column.id}
                onClick={() => setSelectedTaskId(task.id)}
              />
            ))}
          </div>
        </SortableContext>

        {/* ── Add task ── */}
        <div className="p-2 border-t">
          {showAddTask && !addAtTop ? (
            addTaskForm
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-8 text-xs text-muted-foreground justify-start"
              onClick={() => {
                setAddAtTop(false);
                setShowAddTask(true);
              }}
            >
              <Plus className="mr-1 h-3 w-3" />
              Добавить задачу
            </Button>
          )}
        </div>
      </div>

      {/* ── Task modal ── */}
      {selectedTaskId && (
        <TaskModal
          taskId={selectedTaskId}
          workspaceId={workspaceId}
          members={members}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </>
  );
}
