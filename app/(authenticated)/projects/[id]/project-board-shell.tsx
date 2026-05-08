"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Settings, Trash2, Crown, User, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Board } from "@/components/board/Board";
import {
  updateProjectSchema,
  type UpdateProjectInput,
} from "@/lib/schemas/project.schema";
import type { ProjectBoard } from "@/lib/services/project.service";

type Props = {
  project: ProjectBoard;
  currentUserId: string;
  currentUserRole: "ADMIN" | "USER";
};

type UserSearchResult = { id: string; login: string; email: string };

async function apiSearchUsers(
  q: string,
  projectId: string,
): Promise<UserSearchResult[]> {
  const res = await fetch(
    `/api/users/search?q=${encodeURIComponent(q)}&projectId=${projectId}`,
  );
  if (!res.ok) return [];
  return res.json() as Promise<UserSearchResult[]>;
}

async function apiAddMember(projectId: string, loginOrEmail: string) {
  const res = await fetch(`/api/projects/${projectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginOrEmail }),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw data;
  return data;
}

async function apiRemoveMember(projectId: string, userId: string) {
  const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data: unknown = await res.json();
    throw data;
  }
}

async function apiUpdateProject(projectId: string, data: UpdateProjectInput) {
  const res = await fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json: unknown = await res.json();
  if (!res.ok) throw json;
  return json;
}

async function apiDeleteProject(projectId: string) {
  const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
  if (!res.ok) {
    const data: unknown = await res.json();
    throw data;
  }
}

export function ProjectBoardShell({
  project: initialProject,
  currentUserId,
  currentUserRole,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [project, setProject] = useState(initialProject);
  const isOwner =
    currentUserRole === "ADMIN" ||
    project.members.some((m) => m.id === currentUserId && m.role === "OWNER");

  // Add member dialog
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const doSearch = useCallback(
    (q: string) => {
      if (q.length < 2) {
        setSearchResults([]);
        setShowDropdown(false);
        return;
      }
      setSearching(true);
      apiSearchUsers(q, project.id).then((results) => {
        setSearchResults(results);
        setShowDropdown(true);
        setSearching(false);
      });
    },
    [project.id],
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(memberSearch), 300);
    return () => clearTimeout(debounceRef.current);
  }, [memberSearch, doSearch]);

  const addMemberMutation = useMutation({
    mutationFn: (loginOrEmail: string) =>
      apiAddMember(project.id, loginOrEmail),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      toastSuccess("Участник добавлен");
      setMemberSearch("");
      setSearchResults([]);
      setAddMemberOpen(false);
      router.refresh();
    },
    onError: toastApiError,
  });

  // Settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const {
    register: registerSettings,
    handleSubmit: handleSettingsSubmit,
    reset: resetSettings,
    formState: { errors: settingsErrors },
  } = useForm<UpdateProjectInput>({
    resolver: zodResolver(updateProjectSchema),
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateProjectInput) =>
      apiUpdateProject(project.id, data),
    onSuccess: (updated) => {
      setProject((prev) => ({
        ...prev,
        ...(updated as Partial<ProjectBoard>),
      }));
      toastSuccess("Проект обновлён");
      resetSettings();
      setSettingsOpen(false);
    },
    onError: toastApiError,
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDeleteProject(project.id),
    onSuccess: () => {
      toastSuccess("Проект удалён");
      router.push("/projects");
    },
    onError: toastApiError,
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => apiRemoveMember(project.id, userId),
    onSuccess: () => {
      toastSuccess("Участник удалён");
      router.refresh();
    },
    onError: toastApiError,
  });

  function getInitials(login: string) {
    return login.slice(0, 2).toUpperCase();
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
        </div>
        {isOwner && (
          <div className="flex gap-2">
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
          </div>
        )}
      </div>

      {/* Members */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Участники ({project.members.length})
        </h2>
        <div className="flex flex-wrap gap-3">
          {project.members.map((member) => (
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
      </div>

      {/* Kanban Board */}
      <Board initialData={project} projectId={project.id} />

      {/* Add member dialog */}
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
            <div className="space-y-1" ref={searchRef}>
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

      {/* Settings dialog */}
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

          {/* Danger zone */}
          <div className="mt-4 rounded-lg border border-destructive/30 p-4">
            <h3 className="mb-2 text-sm font-semibold text-destructive">
              Опасная зона
            </h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Для удаления введите название проекта:{" "}
              <strong>{project.name}</strong>
            </p>
            <Input
              placeholder={project.name}
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="mb-2"
            />
            <Button
              variant="destructive"
              size="sm"
              disabled={
                deleteConfirm !== project.name || deleteMutation.isPending
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
