"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createUserSchema,
  type CreateUserInput,
} from "@/lib/schemas/user.schema";
import { toastSuccess, toastError } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ─── Types ───────────────────────────────────────────────────────────────────

type UserAdmin = {
  id: string;
  login: string;
  email: string;
  role: "ADMIN" | "USER";
  isActive: boolean;
  telegramConnected: boolean;
  createdAt: string;
};

type UsersResponse = {
  data: UserAdmin[];
  total: number;
  page: number;
  pageSize: number;
};

type CreateUserResponse = UserAdmin & { temporaryPassword: string };

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchUsers(page: number): Promise<UsersResponse> {
  const res = await fetch(`/api/admin/users?page=${page}&pageSize=50`);
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(err.error ?? "Ошибка загрузки пользователей");
  }
  return res.json() as Promise<UsersResponse>;
}

async function createUserApi(
  data: CreateUserInput,
): Promise<CreateUserResponse> {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = (await res.json()) as CreateUserResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Ошибка создания пользователя");
  return json;
}

async function deactivateUserApi(id: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}/deactivate`, {
    method: "PATCH",
  });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(err.error ?? "Ошибка деактивации");
  }
}

async function activateUserApi(id: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}/activate`, {
    method: "PATCH",
  });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(err.error ?? "Ошибка активации");
  }
}

async function changeRoleApi(
  id: string,
  role: "ADMIN" | "USER",
): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(err.error ?? "Ошибка изменения роли");
  }
}

async function resetPasswordApi(
  id: string,
): Promise<{ temporaryPassword: string }> {
  const res = await fetch(`/api/admin/users/${id}/reset-password`, {
    method: "POST",
  });
  const json = (await res.json()) as {
    temporaryPassword: string;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? "Ошибка сброса пароля");
  return json;
}

// ─── Create User Dialog ───────────────────────────────────────────────────────

function CreateUserDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema) as Resolver<CreateUserInput>,
    defaultValues: { role: "USER" },
  });

  const mutation = useMutation({
    mutationFn: createUserApi,
    onSuccess: (data) => {
      setGeneratedPassword(data.temporaryPassword);
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toastSuccess(`Пользователь ${data.login} создан`);
    },
    onError: (err: Error) => {
      toastError(err.message);
    },
  });

  function handleClose() {
    setGeneratedPassword(null);
    setCopied(false);
    reset();
    onClose();
  }

  async function copyPassword() {
    if (!generatedPassword) return;
    await navigator.clipboard.writeText(generatedPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        {generatedPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Пользователь создан</DialogTitle>
              <DialogDescription>
                Сохраните пароль — он показывается только один раз.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-center">
              <p className="mb-1 text-xs text-yellow-700 font-medium uppercase tracking-wide">
                Временный пароль
              </p>
              <p className="text-2xl font-mono font-bold tracking-widest text-yellow-900 select-all">
                {generatedPassword}
              </p>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              ⚠️ После закрытия этого окна пароль будет недоступен. Скопируйте
              его сейчас.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Закрыть
              </Button>
              <Button onClick={copyPassword}>
                {copied ? "Скопировано!" : "Скопировать пароль"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Создать пользователя</DialogTitle>
              <DialogDescription>
                Пароль будет сгенерирован автоматически.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={handleSubmit((data) => mutation.mutate(data))}
              className="space-y-4"
            >
              <div className="space-y-1">
                <Label htmlFor="create-login">Логин</Label>
                <Input
                  id="create-login"
                  placeholder="ivan_petrov"
                  aria-invalid={!!errors.login}
                  {...register("login")}
                />
                {errors.login && (
                  <p className="text-sm text-destructive">
                    {errors.login.message}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="create-email">Email</Label>
                <Input
                  id="create-email"
                  type="email"
                  placeholder="ivan@company.com"
                  aria-invalid={!!errors.email}
                  {...register("email")}
                />
                {errors.email && (
                  <p className="text-sm text-destructive">
                    {errors.email.message}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="create-role">Роль</Label>
                <select
                  id="create-role"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  {...register("role")}
                >
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Отмена
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Создание..." : "Создать"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Reset Password Dialog ────────────────────────────────────────────────────

function ResetPasswordDialog({
  userId,
  userLogin,
  open,
  onClose,
}: {
  userId: string;
  userLogin: string;
  open: boolean;
  onClose: () => void;
}) {
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: () => resetPasswordApi(userId),
    onSuccess: (data) => {
      setNewPassword(data.temporaryPassword);
      toastSuccess("Пароль сброшен");
    },
    onError: (err: Error) => {
      toastError(err.message);
    },
  });

  function handleClose() {
    setNewPassword(null);
    setCopied(false);
    onClose();
  }

  async function copyPassword() {
    if (!newPassword) return;
    await navigator.clipboard.writeText(newPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        {newPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Пароль сброшен</DialogTitle>
              <DialogDescription>
                Новый временный пароль для {userLogin}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-center">
              <p className="mb-1 text-xs text-yellow-700 font-medium uppercase tracking-wide">
                Новый временный пароль
              </p>
              <p className="text-2xl font-mono font-bold tracking-widest text-yellow-900 select-all">
                {newPassword}
              </p>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              ⚠️ Пароль показывается только один раз. Скопируйте его сейчас.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Закрыть
              </Button>
              <Button onClick={copyPassword}>
                {copied ? "Скопировано!" : "Скопировать"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Сброс пароля</DialogTitle>
              <DialogDescription>
                Сгенерировать новый временный пароль для {userLogin}?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Отмена
              </Button>
              <Button
                variant="destructive"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Сброс..." : "Сбросить пароль"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b">
          {Array.from({ length: 6 }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <Skeleton className="h-4 w-full" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ─── Main client component ────────────────────────────────────────────────────

export function UsersClient() {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const queryClient = useQueryClient();
  const [page] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<{
    id: string;
    login: string;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-users", page],
    queryFn: () => fetchUsers(page),
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateUserApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toastSuccess("Пользователь деактивирован");
    },
    onError: (err: Error) => toastError(err.message),
  });

  const activateMutation = useMutation({
    mutationFn: activateUserApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toastSuccess("Пользователь активирован");
    },
    onError: (err: Error) => toastError(err.message),
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: "ADMIN" | "USER" }) =>
      changeRoleApi(id, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toastSuccess("Роль изменена");
    },
    onError: (err: Error) => toastError(err.message),
  });

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Управление пользователями</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `Всего: ${data.total} пользователей` : "Загрузка..."}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          + Создать пользователя
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Логин</th>
              <th className="px-4 py-3 text-left font-medium">Email</th>
              <th className="px-4 py-3 text-left font-medium">Роль</th>
              <th className="px-4 py-3 text-left font-medium">Статус</th>
              <th className="px-4 py-3 text-left font-medium">Создан</th>
              <th className="px-4 py-3 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows />
            ) : (
              data?.data.map((user) => {
                const isSelf = user.id === currentUserId;
                return (
                  <tr
                    key={user.id}
                    className="border-b last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 font-medium">
                      {user.login}
                      {isSelf && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (вы)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          user.role === "ADMIN" ? "default" : "secondary"
                        }
                      >
                        {user.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={user.isActive ? "outline" : "destructive"}
                      >
                        {user.isActive ? "Активен" : "Деактивирован"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            •••
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {user.isActive ? (
                            <DropdownMenuItem
                              disabled={isSelf}
                              onClick={() =>
                                !isSelf && deactivateMutation.mutate(user.id)
                              }
                            >
                              Деактивировать
                              {isSelf && " (недоступно для себя)"}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => activateMutation.mutate(user.id)}
                            >
                              Активировать
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isSelf}
                            onClick={() =>
                              !isSelf &&
                              changeRoleMutation.mutate({
                                id: user.id,
                                role: user.role === "ADMIN" ? "USER" : "ADMIN",
                              })
                            }
                          >
                            Сменить роль на{" "}
                            {user.role === "ADMIN" ? "USER" : "ADMIN"}
                            {isSelf && " (недоступно для себя)"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() =>
                              setResetTarget({ id: user.id, login: user.login })
                            }
                          >
                            Сбросить пароль
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />

      {resetTarget && (
        <ResetPasswordDialog
          userId={resetTarget.id}
          userLogin={resetTarget.login}
          open={true}
          onClose={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}
