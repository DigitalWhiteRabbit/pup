"use client";

import { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  rectIntersection,
  getFirstCollision,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { Column } from "./Column";
import { TaskModal } from "./TaskModal";
import { toastError } from "@/lib/toast";
import { trackAction } from "@/lib/services/action-tracker";
import type { WorkspaceBoard } from "@/lib/services/workspace.service";

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveDrag =
  | { type: "column"; id: string; name: string }
  | { type: "task"; id: string; title: string; columnId: string }
  | null;

type Props = {
  initialData: WorkspaceBoard;
  workspaceId: string;
};

// ─── Board ────────────────────────────────────────────────────────────────────

export function Board({ initialData, workspaceId }: Props) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [urlTaskId, setUrlTaskId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("taskId");
  });

  // TanStack Query manages board state; initialData from SSR for instant render
  const { data: board } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}`);
      if (!res.ok) throw new Error("Failed to load board");
      return res.json() as Promise<WorkspaceBoard>;
    },
    initialData,
    staleTime: 30_000,
  });

  const [activeDrag, setActiveDrag] = useState<ActiveDrag>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Multi-container collision strategy:
  // 1. pointerWithin — works on empty columns (precise target under cursor)
  // 2. rectIntersection — fallback when pointer outside any droppable
  // 3. closestCorners — final fallback for edge cases
  // For task drags, prefer task collisions, but fall back to column collisions
  // (otherwise dropping into an empty column gets stolen by a nearby filled column).
  const collisionDetectionStrategy: CollisionDetection = useCallback((args) => {
    const activeType = args.active.data.current?.type;

    // Column-on-column reorder uses pure closestCorners (horizontal list)
    if (activeType === "column") {
      return closestCorners(args);
    }

    // Task drag: try pointerWithin first — catches empty columns precisely
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      const first = getFirstCollision(pointerCollisions);
      if (first) return pointerCollisions;
    }

    // Pointer not inside any droppable — use rectIntersection
    const rectCollisions = rectIntersection(args);
    if (rectCollisions.length > 0) return rectCollisions;

    // Edge case: nothing intersects — closest corner
    return closestCorners(args);
  }, []);

  // ─── Move task mutation (T046) ─────────────────────────────────────────────
  const moveTaskMutation = useMutation({
    mutationFn: async ({
      taskId,
      columnId,
      position,
    }: {
      taskId: string;
      columnId: string;
      position: number;
    }) => {
      const res = await fetch(`/api/tasks/${taskId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columnId, position }),
      });
      if (!res.ok) throw await res.json();
      return res.json();
    },
    // Snapshot → optimistic update → (error: rollback) → invalidate
    onMutate: async ({ taskId, columnId: targetColumnId, position }) => {
      await queryClient.cancelQueries({ queryKey: ["workspace", workspaceId] });
      const previous = queryClient.getQueryData<WorkspaceBoard>([
        "workspace",
        workspaceId,
      ]);

      queryClient.setQueryData<WorkspaceBoard>(
        ["workspace", workspaceId],
        (old) => {
          if (!old) return old;

          // Remove task from its current column
          let moved: WorkspaceBoard["columns"][0]["tasks"][0] | undefined;
          const cols = old.columns.map((col) => ({
            ...col,
            tasks: col.tasks.filter((t) => {
              if (t.id === taskId) {
                moved = t;
                return false;
              }
              return true;
            }),
          }));

          if (!moved) return old;

          const updatedTask = { ...moved, columnId: targetColumnId, position };

          return {
            ...old,
            columns: cols.map((col) => {
              if (col.id !== targetColumnId) return col;
              // Insert at position and re-index
              const tasks = [...col.tasks, updatedTask].sort(
                (a, b) => a.position - b.position,
              );
              return { ...col, tasks };
            }),
          };
        },
      );

      return { previous };
    },
    onError: (_err, _vars, context) => {
      // Rollback (Constitution XVI)
      if (context?.previous) {
        queryClient.setQueryData(["workspace", workspaceId], context.previous);
      }
      toastError("Не удалось переместить задачу. Изменения отменены.");
    },
    onSuccess: (_data, { taskId }) => {
      trackAction("crm:task:move", `crm:task:move`, taskId);
    },
    onSettled: () => {
      // Sync with server — picks up new totalTimeMs/isInProgress after timer logic
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    },
  });

  // ─── Reorder column mutation (T046) ───────────────────────────────────────
  const reorderColumnMutation = useMutation({
    mutationFn: async ({
      columnId,
      position,
    }: {
      columnId: string;
      position: number;
    }) => {
      const res = await fetch(`/api/columns/${columnId}/position`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position }),
      });
      if (!res.ok) throw await res.json();
      return res.json();
    },
    onMutate: async ({ columnId, position: newIndex }) => {
      await queryClient.cancelQueries({ queryKey: ["workspace", workspaceId] });
      const previous = queryClient.getQueryData<WorkspaceBoard>([
        "workspace",
        workspaceId,
      ]);

      queryClient.setQueryData<WorkspaceBoard>(
        ["workspace", workspaceId],
        (old) => {
          if (!old) return old;
          const sorted = [...old.columns].sort(
            (a, b) => a.position - b.position,
          );
          const oldIndex = sorted.findIndex((c) => c.id === columnId);
          if (oldIndex === -1) return old;
          const reordered = arrayMove(sorted, oldIndex, newIndex);
          return {
            ...old,
            columns: reordered.map((c, i) => ({ ...c, position: i })),
          };
        },
      );

      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["workspace", workspaceId], context.previous);
      }
      toastError("Не удалось переместить колонку. Изменения отменены.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    },
  });

  // ─── Drag handlers ────────────────────────────────────────────────────────
  function handleDragStart(event: DragStartEvent) {
    const { active } = event;
    const data = active.data.current as
      | { type: "column" | "task"; columnId?: string }
      | undefined;
    if (!data) return;

    if (data.type === "column") {
      const col = board.columns.find((c) => c.id === String(active.id));
      setActiveDrag({
        type: "column",
        id: String(active.id),
        name: col?.name ?? "",
      });
    } else {
      const task = board.columns
        .flatMap((c) => c.tasks)
        .find((t) => t.id === String(active.id));
      setActiveDrag({
        type: "task",
        id: String(active.id),
        title: task?.title ?? "",
        columnId: data.columnId ?? "",
      });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDrag(null);

    if (!over || active.id === over.id) return;

    const activeData = active.data.current as
      | { type: string; columnId?: string }
      | undefined;
    const overData = over.data.current as
      | { type: string; columnId?: string }
      | undefined;

    if (!activeData) return;

    if (activeData.type === "column") {
      // ── Column reorder ──
      const sorted = [...board.columns].sort((a, b) => a.position - b.position);
      const newIndex = sorted.findIndex((c) => c.id === String(over.id));
      if (newIndex === -1) return;
      reorderColumnMutation.mutate({
        columnId: String(active.id),
        position: newIndex,
      });
    } else if (activeData.type === "task") {
      // ── Task move ──
      let targetColumnId: string;
      let targetPosition: number;

      if (overData?.type === "column") {
        // Dropped directly on a column (empty area)
        targetColumnId = String(over.id);
        const targetCol = board.columns.find((c) => c.id === targetColumnId);
        targetPosition = targetCol ? targetCol.tasks.length : 0;
      } else if (overData?.type === "task") {
        // Dropped on another task
        targetColumnId = overData.columnId ?? activeData.columnId ?? "";
        const targetCol = board.columns.find((c) => c.id === targetColumnId);
        if (!targetCol) return;
        const targetIndex = targetCol.tasks.findIndex(
          (t) => t.id === String(over.id),
        );
        targetPosition =
          targetIndex >= 0 ? targetIndex : targetCol.tasks.length;
      } else {
        return;
      }

      moveTaskMutation.mutate({
        taskId: String(active.id),
        columnId: targetColumnId,
        position: targetPosition,
      });
    }
  }

  // ─── Add column ───────────────────────────────────────────────────────────
  async function handleAddColumn() {
    const name = newColumnName.trim();
    if (!name) return;
    setAddingColumn(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/columns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw await res.json();
      setNewColumnName("");
      await queryClient.invalidateQueries({
        queryKey: ["workspace", workspaceId],
      });
    } catch {
      toastError("Не удалось создать колонку");
    } finally {
      setAddingColumn(false);
    }
  }

  const sortedColumns = [...board.columns].sort(
    (a, b) => a.position - b.position,
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionStrategy}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortedColumns.map((c) => c.id)}
        strategy={horizontalListSortingStrategy}
      >
        <div
          className="flex gap-3 md:gap-4 overflow-x-auto pb-6 -mx-3 px-3 md:mx-0 md:px-0"
          style={{ touchAction: "none" }}
        >
          {sortedColumns.map((column) => (
            <Column
              key={column.id}
              column={column}
              workspaceId={workspaceId}
              members={board.members}
            />
          ))}

          {/* Add column */}
          <div className="flex-shrink-0 w-[260px] md:w-72">
            {addingColumn ? (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <input
                  autoFocus
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  placeholder="Название колонки"
                  aria-label="Название новой колонки"
                  className="w-full rounded-md border border-input bg-background px-3 h-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddColumn();
                    if (e.key === "Escape") {
                      setAddingColumn(false);
                      setNewColumnName("");
                    }
                  }}
                />
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void handleAddColumn()}
                    disabled={!newColumnName.trim()}
                  >
                    Создать
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setAddingColumn(false);
                      setNewColumnName("");
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full h-12 border-dashed text-muted-foreground"
                onClick={() => setAddingColumn(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Добавить колонку
              </Button>
            )}
          </div>
        </div>
      </SortableContext>

      {/* Drag preview overlay */}
      <DragOverlay>
        {activeDrag?.type === "column" && (
          <div className="w-72 rounded-lg border bg-card p-3 shadow-2xl rotate-2 opacity-90">
            <p className="text-sm font-semibold">{activeDrag.name}</p>
          </div>
        )}
        {activeDrag?.type === "task" && (
          <div className="rounded-lg border bg-card p-3 shadow-2xl rotate-1 opacity-90">
            <p className="text-sm font-medium">{activeDrag.title}</p>
          </div>
        )}
      </DragOverlay>

      {/* URL-driven task modal (from dashboard link) */}
      {urlTaskId && (
        <TaskModal
          taskId={urlTaskId}
          workspaceId={workspaceId}
          members={board.members}
          onClose={() => {
            setUrlTaskId(null);
            router.replace(`/workspaces/${workspaceId}/crm`, { scroll: false });
          }}
        />
      )}
    </DndContext>
  );
}
