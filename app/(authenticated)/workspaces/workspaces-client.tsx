"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  FolderOpen,
  Users,
  CalendarDays,
  Settings,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastSuccess, toastApiError } from "@/lib/toast";
import {
  createWorkspaceSchema,
  type CreateWorkspaceInput,
} from "@/lib/schemas/workspace.schema";
import type { WorkspaceSummary } from "@/lib/services/workspace.service";

type WorkspacesResponse = {
  data: WorkspaceSummary[];
  total: number;
  page: number;
  pageSize: number;
};

async function fetchWorkspaces(): Promise<WorkspacesResponse> {
  const res = await fetch("/api/workspaces");
  if (!res.ok) throw new Error("Ошибка загрузки проектов");
  return res.json() as Promise<WorkspacesResponse>;
}

async function createWorkspaceApi(
  input: CreateWorkspaceInput,
): Promise<WorkspaceSummary> {
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw data;
  return data as WorkspaceSummary;
}

export function WorkspacesClient({
  initialData,
}: {
  initialData: WorkspacesResponse;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsWorkspace, setSettingsWorkspace] =
    useState<WorkspaceSummary | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<WorkspaceSummary | null>(
    null,
  );

  const { data: modulesData } = useQuery<
    { moduleKey: string; enabled: boolean }[]
  >({
    queryKey: ["workspace", settingsWorkspace?.id, "modules"],
    queryFn: async () => {
      const res = await fetch(
        `/api/workspaces/${settingsWorkspace!.id}/modules`,
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!settingsWorkspace,
  });

  const toggleModuleMutation = useMutation({
    mutationFn: async ({
      moduleKey,
      enabled,
    }: {
      moduleKey: string;
      enabled: boolean;
    }) => {
      const res = await fetch(
        `/api/workspaces/${settingsWorkspace!.id}/modules/${moduleKey}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", settingsWorkspace?.id, "modules"],
      });
    },
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      if (!res.ok) throw await res.json();
    },
    onSuccess: () => {
      setDeleteConfirm(null);
      toastSuccess("Проект удалён");
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces-switcher"] });
    },
    onError: toastApiError,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
    initialData,
    staleTime: 30_000,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateWorkspaceInput>({
    resolver: zodResolver(createWorkspaceSchema),
  });

  const createMutation = useMutation({
    mutationFn: createWorkspaceApi,
    onSuccess: (workspace) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["workspaces-switcher"] });
      toastSuccess(`Проект "${workspace.name}" создан`);
      reset();
      setDialogOpen(false);
      router.push(`/workspaces/${workspace.id}/dashboard`);
    },
    onError: (err) => {
      toastApiError(err);
    },
  });

  function onSubmit(values: CreateWorkspaceInput) {
    createMutation.mutate(values);
  }

  const workspaces = data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Проекты</h1>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Создать проект
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <FolderOpen className="mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Нет проектов</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Создайте первый проект, чтобы начать работу
          </p>
          <Button className="mt-4" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Создать проект
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => (
            <Card
              key={workspace.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() =>
                router.push(`/workspaces/${workspace.id}/dashboard`)
              }
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate text-base flex-1">
                    {workspace.name}
                  </CardTitle>
                  <div
                    className="flex gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Настройки"
                      onClick={() => setSettingsWorkspace(workspace)}
                    >
                      <Settings className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Удалить"
                      onClick={() => setDeleteConfirm(workspace)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {workspace.description && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {workspace.description}
                  </p>
                )}
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {workspace.memberCount} участн.
                  </span>
                  <span className="flex items-center gap-1">
                    <CalendarDays className="h-3 w-3" />
                    {formatDistanceToNow(new Date(workspace.createdAt), {
                      addSuffix: true,
                      locale: ru,
                    })}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Settings dialog */}
      <Dialog
        open={!!settingsWorkspace}
        onOpenChange={(o) => !o && setSettingsWorkspace(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Модули — {settingsWorkspace?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {(modulesData ?? []).map((m) => {
              const labels: Record<string, string> = {
                crm: "CRM-доска",
                knowledge: "База знаний",
                tickets: "Тикеты",
                logs: "Логи",
                chat: "Чат",
                marketing: "Маркетинг",
                analytics: "Аналитика",
                users: "Пользователи",
              };
              return (
                <div
                  key={m.moduleKey}
                  className="flex items-center justify-between"
                >
                  <Label>{labels[m.moduleKey] ?? m.moduleKey}</Label>
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={(enabled) =>
                      toggleModuleMutation.mutate({
                        moduleKey: m.moduleKey,
                        enabled,
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSettingsWorkspace(null)}
            >
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(o) => !o && setDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить проект?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Проект <strong>{deleteConfirm?.name}</strong> и все его данные будут
            удалены безвозвратно.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteConfirm && deleteMutation.mutate(deleteConfirm.id)
              }
            >
              {deleteMutation.isPending ? "Удаление..." : "Удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новый проект</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="name">Название *</Label>
              <Input id="name" placeholder="Мой проект" {...register("name")} />
              {errors.name && (
                <p className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Описание</Label>
              <Textarea
                id="description"
                placeholder="Краткое описание проекта"
                rows={3}
                {...register("description")}
              />
              {errors.description && (
                <p className="text-xs text-destructive">
                  {errors.description.message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                  reset();
                }}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Создание..." : "Создать"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
