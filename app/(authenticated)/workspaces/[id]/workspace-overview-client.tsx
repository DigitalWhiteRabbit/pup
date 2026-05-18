"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Kanban,
  BookOpen,
  Ticket,
  ScrollText,
  MessageSquare,
  Megaphone,
  BarChart3,
  Users,
  UserPlus,
  Settings,
  LayoutDashboard,
  Trash2,
  Crown,
  User,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
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
import { toastSuccess, toastApiError } from "@/lib/toast";
import { WorkspaceLogoUpload } from "./workspace-logo-upload";
import {
  updateWorkspaceSchema,
  type UpdateWorkspaceInput,
} from "@/lib/schemas/workspace.schema";
import type {
  WorkspaceBoard,
  ModuleKey,
} from "@/lib/services/workspace.service";

// ─── Module metadata ──────────────────────────────────────────────────────────

type ModuleMeta = {
  label: string;
  description: string;
  icon: React.ReactNode;
};

const MODULE_META: Record<ModuleKey, ModuleMeta> = {
  crm: {
    label: "CRM-доска",
    description: "Канбан-доска для управления задачами",
    icon: <Kanban className="h-8 w-8" />,
  },
  knowledge: {
    label: "База знаний",
    description: "Документы и справочные материалы",
    icon: <BookOpen className="h-8 w-8" />,
  },
  tickets: {
    label: "Тикеты",
    description: "Обращения и задачи поддержки",
    icon: <Ticket className="h-8 w-8" />,
  },
  logs: {
    label: "Логи",
    description: "Журнал событий workspace",
    icon: <ScrollText className="h-8 w-8" />,
  },
  chat: {
    label: "Чат",
    description: "Внутренний мессенджер команды",
    icon: <MessageSquare className="h-8 w-8" />,
  },
  marketing: {
    label: "Маркетинг",
    description: "Управление маркетинговыми кампаниями",
    icon: <Megaphone className="h-8 w-8" />,
  },
  analytics: {
    label: "Аналитика",
    description: "Отчёты и дашборды",
    icon: <BarChart3 className="h-8 w-8" />,
  },
  users: {
    label: "Пользователи проекта",
    description: "Участники и роли workspace",
    icon: <Users className="h-8 w-8" />,
  },
};

const MODULE_ORDER: ModuleKey[] = [
  "crm",
  "knowledge",
  "tickets",
  "logs",
  "chat",
  "marketing",
  "analytics",
  "users",
];

// ─── API helpers ──────────────────────────────────────────────────────────────

type ModuleState = { moduleKey: ModuleKey; enabled: boolean };
type UserSearchResult = { id: string; login: string; email: string };

async function apiFetchModules(workspaceId: string): Promise<ModuleState[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/modules`);
  if (!res.ok) throw new Error("Failed to fetch modules");
  return res.json() as Promise<ModuleState[]>;
}

async function apiSetModuleEnabled(
  workspaceId: string,
  moduleKey: string,
  enabled: boolean,
) {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/modules/${moduleKey}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) throw await res.json();
}

async function apiSearchUsers(
  q: string,
  workspaceId: string,
): Promise<UserSearchResult[]> {
  const res = await fetch(
    `/api/users/search?q=${encodeURIComponent(q)}&workspaceId=${workspaceId}`,
  );
  if (!res.ok) return [];
  return res.json() as Promise<UserSearchResult[]>;
}

async function apiAddMember(workspaceId: string, loginOrEmail: string) {
  const res = await fetch(`/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginOrEmail }),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw data;
  return data;
}

async function apiRemoveMember(workspaceId: string, userId: string) {
  const res = await fetch(`/api/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data: unknown = await res.json();
    throw data;
  }
}

async function apiUpdateWorkspace(
  workspaceId: string,
  data: UpdateWorkspaceInput,
) {
  const res = await fetch(`/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json: unknown = await res.json();
  if (!res.ok) throw json;
  return json;
}

async function apiDeleteWorkspace(workspaceId: string) {
  const res = await fetch(`/api/workspaces/${workspaceId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data: unknown = await res.json();
    throw data;
  }
}

async function apiFetchWorkspace(workspaceId: string): Promise<WorkspaceBoard> {
  const res = await fetch(`/api/workspaces/${workspaceId}`);
  if (!res.ok) throw new Error("Failed to fetch workspace");
  return res.json() as Promise<WorkspaceBoard>;
}

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  workspace: WorkspaceBoard;
  modules: ModuleState[];
  isOwner: boolean;
  currentUserId: string;
};

export function WorkspaceOverviewClient({
  workspace: initialWorkspace,
  modules: initialModules,
  isOwner,
  currentUserId: _currentUserId,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: workspace } = useQuery({
    queryKey: ["workspace", initialWorkspace.id],
    queryFn: () => apiFetchWorkspace(initialWorkspace.id),
    initialData: initialWorkspace,
    refetchInterval: 30_000,
  });

  const { data: modules, isLoading: modulesLoading } = useQuery({
    queryKey: ["workspace", workspace.id, "modules"],
    queryFn: () => apiFetchModules(workspace.id),
    initialData: initialModules,
    staleTime: 10_000,
  });

  const refreshWorkspace = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["workspace", workspace.id],
    });
  }, [queryClient, workspace.id]);

  // ─── Module toggle ─────────────────────────────────────────────────────────
  const toggleModuleMutation = useMutation({
    mutationFn: ({
      moduleKey,
      enabled,
    }: {
      moduleKey: string;
      enabled: boolean;
    }) => apiSetModuleEnabled(workspace.id, moduleKey, enabled),
    onMutate: async ({ moduleKey, enabled }) => {
      await queryClient.cancelQueries({
        queryKey: ["workspace", workspace.id, "modules"],
      });
      const previous = queryClient.getQueryData<ModuleState[]>([
        "workspace",
        workspace.id,
        "modules",
      ]);
      queryClient.setQueryData<ModuleState[]>(
        ["workspace", workspace.id, "modules"],
        (old) =>
          old?.map((m) =>
            m.moduleKey === moduleKey ? { ...m, enabled } : m,
          ) ?? [],
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ["workspace", workspace.id, "modules"],
          context.previous,
        );
      }
      toastApiError(_err);
    },
    onSuccess: (_data, { enabled }) => {
      toastSuccess(enabled ? "Модуль включён" : "Модуль выключен");
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspace.id, "modules"],
      });
    },
  });

  // ─── Add member ────────────────────────────────────────────────────────────
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const doSearch = useCallback(
    (q: string) => {
      if (q.length < 2) {
        setSearchResults([]);
        setShowDropdown(false);
        return;
      }
      setSearching(true);
      apiSearchUsers(q, workspace.id).then((results) => {
        setSearchResults(results);
        setShowDropdown(true);
        setSearching(false);
      });
    },
    [workspace.id],
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(memberSearch), 300);
    return () => clearTimeout(debounceRef.current);
  }, [memberSearch, doSearch]);

  const addMemberMutation = useMutation({
    mutationFn: (loginOrEmail: string) =>
      apiAddMember(workspace.id, loginOrEmail),
    onSuccess: async () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", workspace.id],
      });
      toastSuccess("Участник добавлен");
      setMemberSearch("");
      setSearchResults([]);
      setAddMemberOpen(false);
      await refreshWorkspace();
    },
    onError: toastApiError,
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => apiRemoveMember(workspace.id, userId),
    onSuccess: async () => {
      toastSuccess("Участник удалён");
      await refreshWorkspace();
    },
    onError: toastApiError,
  });

  // ─── Settings ──────────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const {
    register: registerSettings,
    handleSubmit: handleSettingsSubmit,
    reset: resetSettings,
    formState: { errors: settingsErrors },
  } = useForm<UpdateWorkspaceInput>({
    resolver: zodResolver(updateWorkspaceSchema),
    defaultValues: {
      name: workspace.name,
      description: workspace.description ?? "",
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateWorkspaceInput) =>
      apiUpdateWorkspace(workspace.id, data),
    onSuccess: () => {
      void refreshWorkspace();
      toastSuccess("Проект обновлён");
      resetSettings();
      setSettingsOpen(false);
    },
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDeleteWorkspace(workspace.id),
    onSuccess: () => {
      toastSuccess("Проект удалён");
      router.push("/workspaces");
    },
    onError: toastApiError,
  });

  function getInitials(login: string) {
    return login.slice(0, 2).toUpperCase();
  }

  const modulesMap = new Map(
    (modules ?? []).map((m) => [m.moduleKey, m.enabled]),
  );

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* ── Header ── */}
      <div className="mb-6 md:mb-8 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-4">
          <WorkspaceLogoUpload
            workspaceId={workspace.id}
            name={workspace.name}
            hasLogo={!!workspace.logoPath}
            isOwner={isOwner}
          />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{workspace.name}</h1>
            {workspace.description && (
              <p className="mt-1 text-muted-foreground">
                {workspace.description}
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Владелец: {workspace.owner.login} · {workspace.members.length}{" "}
              участн.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/workspaces/${workspace.id}/dashboard`}>
            <Button variant="default" size="sm">
              <LayoutDashboard className="mr-1 h-4 w-4" />
              Dashboard
            </Button>
          </Link>
          {isOwner && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddMemberOpen(true)}
              >
                <UserPlus className="mr-1 h-4 w-4" />
                Добавить участника
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="mr-1 h-4 w-4" />
                Настройки
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Modules grid ── */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">Модули</h2>
        {modulesLoading ? (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="h-40 animate-pulse bg-muted" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {MODULE_ORDER.map((key) => {
              const meta = MODULE_META[key];
              const enabled = modulesMap.get(key) ?? false;
              const isDisabledForUser = !enabled && !isOwner;

              return (
                <Card
                  key={key}
                  className={isDisabledForUser ? "opacity-50" : undefined}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="text-muted-foreground">{meta.icon}</div>
                      {isOwner && (
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            toggleModuleMutation.mutate({
                              moduleKey: key,
                              enabled: checked,
                            })
                          }
                          disabled={toggleModuleMutation.isPending}
                        />
                      )}
                    </div>
                    <CardTitle className="text-sm mt-2">{meta.label}</CardTitle>
                    <CardDescription className="text-xs">
                      {meta.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {enabled && (
                      <Button
                        asChild
                        size="sm"
                        className="w-full"
                        variant="outline"
                      >
                        <Link href={`/workspaces/${workspace.id}/${key}`}>
                          Открыть
                        </Link>
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Members ── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Участники ({workspace.members.length})
        </h2>
        <div className="flex flex-wrap gap-3">
          {workspace.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2"
            >
              <Avatar className="h-7 w-7">
                <AvatarFallback className="text-xs">
                  {getInitials(member.login)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-sm font-medium">{member.login}</p>
              </div>
              <Badge
                variant={member.role === "OWNER" ? "default" : "secondary"}
                className="text-xs"
              >
                {member.role === "OWNER" ? (
                  <>
                    <Crown className="mr-1 h-3 w-3" />
                    Владелец
                  </>
                ) : (
                  <>
                    <User className="mr-1 h-3 w-3" />
                    Участник
                  </>
                )}
              </Badge>
              {isOwner && member.role !== "OWNER" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  onClick={() => removeMemberMutation.mutate(member.id)}
                  disabled={removeMemberMutation.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Add member dialog ── */}
      <Dialog
        open={addMemberOpen}
        onOpenChange={(v) => {
          setAddMemberOpen(v);
          if (!v) {
            setMemberSearch("");
            setSearchResults([]);
            setShowDropdown(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Добавить участника</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="memberSearch">Поиск по логину или email</Label>
              <div className="relative">
                <Input
                  id="memberSearch"
                  placeholder="Начните вводить логин или email..."
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  autoComplete="off"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
              {showDropdown && (
                <div className="mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
                  {searchResults.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      Пользователи не найдены
                    </p>
                  ) : (
                    searchResults.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                        disabled={addMemberMutation.isPending}
                        onClick={() => {
                          setShowDropdown(false);
                          addMemberMutation.mutate(u.login);
                        }}
                      >
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-xs">
                            {u.login.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{u.login}</span>
                          <span className="ml-2 text-muted-foreground">
                            {u.email}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddMemberOpen(false);
                  setMemberSearch("");
                  setSearchResults([]);
                }}
              >
                Отмена
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Settings dialog ── */}
      <Dialog
        open={settingsOpen}
        onOpenChange={(v) => {
          setSettingsOpen(v);
          if (!v) setDeleteConfirm("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Настройки проекта</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={handleSettingsSubmit((v) => updateMutation.mutate(v))}
            className="space-y-4"
          >
            <div className="space-y-1">
              <Label htmlFor="proj-name">Название</Label>
              <Input id="proj-name" {...registerSettings("name")} />
              {settingsErrors.name && (
                <p className="text-xs text-destructive">
                  {settingsErrors.name.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="proj-desc">Описание</Label>
              <Textarea
                id="proj-desc"
                rows={3}
                {...registerSettings("description")}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSettingsOpen(false)}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Сохранение..." : "Сохранить"}
              </Button>
            </DialogFooter>
          </form>

          <div className="mt-4 rounded-lg border border-destructive/30 p-4">
            <h3 className="mb-2 text-sm font-semibold text-destructive">
              Опасная зона
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Для удаления введите название проекта:{" "}
              <strong>{workspace.name}</strong>
            </p>
            <Input
              placeholder={workspace.name}
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="mb-2"
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={
                deleteConfirm !== workspace.name || deleteMutation.isPending
              }
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {deleteMutation.isPending ? "Удаление..." : "Удалить проект"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
