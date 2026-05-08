"use client";

import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Clock, Timer, GripVertical } from "lucide-react";
import type { ProjectBoard } from "@/lib/services/project.service";

const priorityConfig: Record<
  string,
  { label: string; color: string } | undefined
> = {
  LOW: { label: "Низкий", color: "bg-blue-100 text-blue-700" },
  MEDIUM: { label: "Средний", color: "bg-yellow-100 text-yellow-700" },
  HIGH: { label: "Высокий", color: "bg-orange-100 text-orange-700" },
  URGENT: { label: "Срочный", color: "bg-red-100 text-red-700" },
};

type Task = ProjectBoard["columns"][0]["tasks"][0];

// ─── Time formatting ──────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0с";
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}с`;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600) % 24;
  const days = Math.floor(totalSecs / 86400);
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${mins}м`;
  return `${mins}м`;
}

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  task: Task;
  columnId: string;
  onClick: () => void;
};

export function TaskCard({ task, columnId, onClick }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: "task", columnId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Live timer — increments every second when isInProgress
  const [liveMs, setLiveMs] = useState(task.totalTimeMs);

  useEffect(() => {
    setLiveMs(task.totalTimeMs);

    if (!task.isInProgress || !task.lastIntervalStartedAt) return;

    const startedAt = new Date(task.lastIntervalStartedAt).getTime();

    function tick() {
      setLiveMs(task.totalTimeMs + (Date.now() - startedAt));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [task.isInProgress, task.totalTimeMs, task.lastIntervalStartedAt]);

  const showTimeBadge = liveMs > 0 || task.isInProgress;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group rounded-lg border bg-card p-3 shadow-sm cursor-pointer hover:shadow-md transition-shadow select-none ${
        isDragging ? "opacity-40 ring-2 ring-primary" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-start gap-2">
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0">
          {task.priority &&
            task.priority !== "NONE" &&
            priorityConfig[task.priority] && (
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${priorityConfig[task.priority]!.color}`}
              >
                {priorityConfig[task.priority]!.label}
              </span>
            )}
          <p className="text-sm font-medium leading-snug break-words">
            {task.title}
          </p>

          {/* Footer: assignees + time */}
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex -space-x-1.5">
              {task.assignees.map((a) => (
                <Avatar key={a.id} className="h-6 w-6 border-2 border-card">
                  <AvatarFallback
                    className={`text-[10px] ${!a.isActive ? "opacity-40" : ""}`}
                    title={a.isActive ? a.login : `${a.login} (деактивирован)`}
                  >
                    {a.login.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>

            {showTimeBadge && (
              <Badge
                variant={task.isInProgress ? "default" : "secondary"}
                className="text-xs font-mono gap-1 shrink-0"
              >
                {task.isInProgress ? (
                  <Timer className="h-3 w-3" />
                ) : (
                  <Clock className="h-3 w-3" />
                )}
                {formatDuration(liveMs)}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
