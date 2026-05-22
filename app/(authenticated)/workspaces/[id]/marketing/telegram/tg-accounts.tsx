"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Plus,
  Search,
  Loader2,
  Phone,
  Crown,
  Trash2,
  Upload,
  FileArchive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toastSuccess, toastApiError } from "@/lib/toast";
import {
  type TgSectionProps,
  tgApi,
  tgFetch,
  tgPost,
  tgPatch,
  tgDelete,
  tgUpload,
  AccountStatusBadge,
  EmptyState,
  formatDate,
} from "./tg-shared";

// ── Account statuses ──

const ACCOUNT_STATUSES = [
  "ALL",
  "IMPORTED",
  "ACTIVE",
  "WARMING",
  "PAUSED",
  "FLOOD_WAIT",
  "SPAM_BLOCKED",
  "BANNED",
  "DEAD",
] as const;

const STATUS_LABELS: Record<string, string> = {
  ALL: "Все",
  IMPORTED: "Импортированные",
  ACTIVE: "Активные",
  WARMING: "На прогреве",
  PAUSED: "На паузе",
  FLOOD_WAIT: "Флуд-блок",
  SPAM_BLOCKED: "Спам-блок",
  BANNED: "Забанены",
  DEAD: "Мёртвые",
};

// ── Warmup level bar ──

function WarmupBar({ level }: { level: number }) {
  const maxLevel = 10;
  const pct = Math.min(100, Math.round((level / maxLevel) * 100));
  let color = "bg-orange-500";
  if (level >= 8) color = "bg-emerald-500";
  else if (level >= 5) color = "bg-yellow-500";

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground">
        {level}/{maxLevel}
      </span>
    </div>
  );
}

// ── Main component ──

export function AccountsSection({ workspaceId }: TgSectionProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showZipImport, setShowZipImport] = useState(false);
  const [editAccount, setEditAccount] = useState<any | null>(null);
  const pageSize = 25;

  // Build query params
  const queryParams = new URLSearchParams();
  queryParams.set("limit", String(pageSize));
  queryParams.set("offset", String(page * pageSize));
  if (statusFilter !== "ALL") queryParams.set("status", statusFilter);
  if (search.trim()) queryParams.set("search", search.trim());

  const { data, isLoading } = useQuery({
    queryKey: ["tg-accounts", workspaceId, statusFilter, search, page],
    queryFn: () =>
      tgFetch(tgApi(workspaceId, `/accounts?${queryParams.toString()}`)),
  });

  const { data: stats } = useQuery({
    queryKey: ["tg-accounts-stats", workspaceId],
    queryFn: () => tgFetch(tgApi(workspaceId, "/accounts/stats")),
  });

  const accounts: any[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tgDelete(tgApi(workspaceId, `/accounts/${id}`)),
    onSuccess: () => {
      toastSuccess("Аккаунт удалён");
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts", workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts-stats", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const handleRowClick = useCallback((acc: any) => {
    setEditAccount(acc);
  }, []);

  if (isLoading && page === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-extrabold">Аккаунты</h2>
          {stats && (
            <div className="flex items-center gap-1.5">
              <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">
                Active: {stats.by_status?.ACTIVE ?? 0}
              </Badge>
              <Badge className="bg-red-500/10 text-red-500 text-xs">
                Banned: {stats.by_status?.BANNED ?? 0}
              </Badge>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowZipImport(true)}
          >
            <FileArchive className="h-3.5 w-3.5 mr-1.5" />
            Импорт ZIP
          </Button>
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white"
            size="sm"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Добавить аккаунт
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            {ACCOUNT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s] || s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Поиск по телефону, юзернейму..."
            className="pl-9 text-sm"
          />
        </div>
        <div className="text-xs text-muted-foreground ml-auto">
          {total} аккаунтов
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {accounts.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Телефон
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Юзернейм
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Статус
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Прогрев
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Прокси
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Страна
                    </th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground">
                      Премиум
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Создан
                    </th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc: any) => (
                    <tr
                      key={acc.id}
                      className="border-b border-border/50 hover:bg-muted/20 cursor-pointer transition-colors"
                      onClick={() => handleRowClick(acc)}
                    >
                      <td className="px-3 py-2.5 font-medium">
                        <div className="flex items-center gap-1.5">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          {acc.phone || "--"}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {acc.username ? `@${acc.username}` : "--"}
                      </td>
                      <td className="px-3 py-2.5">
                        <AccountStatusBadge status={acc.status} />
                      </td>
                      <td className="px-3 py-2.5">
                        <WarmupBar level={acc.warmup_level ?? 0} />
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {acc.proxy_label || acc.proxy_id || "--"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {acc.country || "--"}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        {acc.is_premium ? (
                          <Crown className="h-3.5 w-3.5 text-yellow-500 mx-auto" />
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {formatDate(acc.created_at)}
                      </td>
                      <td className="px-3 py-2.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm("Удалить аккаунт?")) {
                              deleteMutation.mutate(acc.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          aria-label="Удалить аккаунт"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={Users}
              title="Нет аккаунтов"
              description="Добавьте Telegram аккаунты для начала работы"
              action={
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={() => setShowCreate(true)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Добавить первый аккаунт
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Страница {page + 1} из {totalPages}
          </div>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="text-xs h-8"
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="text-xs h-8"
            >
              Далее
            </Button>
          </div>
        </div>
      )}

      {/* Create Dialog */}
      <CreateAccountDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        workspaceId={workspaceId}
      />

      {/* ZIP Import Dialog */}
      <ZipImportDialog
        open={showZipImport}
        onClose={() => setShowZipImport(false)}
        workspaceId={workspaceId}
      />

      {/* Edit Dialog */}
      {editAccount && (
        <EditAccountDialog
          open={!!editAccount}
          onClose={() => setEditAccount(null)}
          workspaceId={workspaceId}
          account={editAccount}
        />
      )}
    </div>
  );
}

// ── Create Account Dialog ──

function CreateAccountDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    phone: "",
    session_path: "",
    device_model: "",
    system_version: "",
    country: "",
    tags: "",
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      tgPost(tgApi(workspaceId, "/accounts"), {
        ...data,
        tags: data.tags
          ? data.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [],
      }),
    onSuccess: () => {
      toastSuccess("Аккаунт добавлен");
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts", workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts-stats", workspaceId],
      });
      handleClose();
    },
    onError: toastApiError,
  });

  function handleClose() {
    if (!createMutation.isPending) {
      setForm({
        phone: "",
        session_path: "",
        device_model: "",
        system_version: "",
        country: "",
        tags: "",
      });
      onClose();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim()) return;
    createMutation.mutate(form);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4" />
            Добавить аккаунт
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
              Телефон *
            </label>
            <Input
              value={form.phone}
              onChange={(e) =>
                setForm((p) => ({ ...p, phone: e.target.value }))
              }
              placeholder="+79001234567"
              className="text-sm"
              autoFocus
              disabled={createMutation.isPending}
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
              Путь к session-файлу
            </label>
            <Input
              value={form.session_path}
              onChange={(e) =>
                setForm((p) => ({ ...p, session_path: e.target.value }))
              }
              placeholder="/sessions/account1.session"
              className="text-sm"
              disabled={createMutation.isPending}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Модель устройства
              </label>
              <Input
                value={form.device_model}
                onChange={(e) =>
                  setForm((p) => ({ ...p, device_model: e.target.value }))
                }
                placeholder="Samsung Galaxy S23"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Версия системы
              </label>
              <Input
                value={form.system_version}
                onChange={(e) =>
                  setForm((p) => ({ ...p, system_version: e.target.value }))
                }
                placeholder="Android 14"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Страна
              </label>
              <Input
                value={form.country}
                onChange={(e) =>
                  setForm((p) => ({ ...p, country: e.target.value }))
                }
                placeholder="RU"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Теги (через запятую)
              </label>
              <Input
                value={form.tags}
                onChange={(e) =>
                  setForm((p) => ({ ...p, tags: e.target.value }))
                }
                placeholder="main, premium"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={createMutation.isPending}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={!form.phone.trim() || createMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {createMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Добавить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Account Dialog ──

function EditAccountDialog({
  open,
  onClose,
  workspaceId,
  account,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  account: any;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    status: account.status || "IMPORTED",
    device_model: account.device_model || "",
    system_version: account.system_version || "",
    country: account.country || "",
    tags: Array.isArray(account.tags) ? account.tags.join(", ") : "",
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      tgPatch(tgApi(workspaceId, `/accounts/${account.id}`), {
        ...data,
        tags: data.tags
          ? data.tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [],
      }),
    onSuccess: () => {
      toastSuccess("Аккаунт обновлён");
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts", workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts-stats", workspaceId],
      });
      onClose();
    },
    onError: toastApiError,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate(form);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Phone className="h-4 w-4" />
            Редактирование: {account.phone}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
              Статус
            </label>
            <Select
              value={form.status}
              onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_STATUSES.filter((s) => s !== "ALL").map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s] || s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Модель устройства
              </label>
              <Input
                value={form.device_model}
                onChange={(e) =>
                  setForm((p) => ({ ...p, device_model: e.target.value }))
                }
                className="text-sm"
                disabled={updateMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Версия системы
              </label>
              <Input
                value={form.system_version}
                onChange={(e) =>
                  setForm((p) => ({ ...p, system_version: e.target.value }))
                }
                className="text-sm"
                disabled={updateMutation.isPending}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Страна
              </label>
              <Input
                value={form.country}
                onChange={(e) =>
                  setForm((p) => ({ ...p, country: e.target.value }))
                }
                className="text-sm"
                disabled={updateMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Теги (через запятую)
              </label>
              <Input
                value={form.tags}
                onChange={(e) =>
                  setForm((p) => ({ ...p, tags: e.target.value }))
                }
                className="text-sm"
                disabled={updateMutation.isPending}
              />
            </div>
          </div>

          {/* Read-only info */}
          <div className="bg-muted/30 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
            <div>
              Юзернейм:{" "}
              <span className="text-foreground font-medium">
                {account.username ? `@${account.username}` : "--"}
              </span>
            </div>
            <div>
              Прогрев:{" "}
              <span className="text-foreground font-medium">
                уровень {account.warmup_level ?? 0}
              </span>
            </div>
            <div>
              Создан:{" "}
              <span className="text-foreground font-medium">
                {formatDate(account.created_at)}
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={updateMutation.isPending}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={updateMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {updateMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── ZIP Import Dialog ──

function ZipImportDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    errors: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      tgUpload(tgApi(workspaceId, "/accounts/import-zip"), file),
    onSuccess: (data: any) => {
      setResult({
        imported: data?.imported ?? 0,
        skipped: data?.skipped ?? 0,
        errors: data?.errors ?? 0,
      });
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts", workspaceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tg-accounts-stats", workspaceId],
      });
    },
    onError: toastApiError,
  });

  function handleClose() {
    if (!uploadMutation.isPending) {
      setSelectedFile(null);
      setResult(null);
      setIsDragging(false);
      onClose();
    }
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.name.endsWith(".zip")) {
      toastApiError(new Error("Файл должен быть в формате .zip"));
      return;
    }
    setSelectedFile(file);
    setResult(null);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFile(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleSubmit() {
    if (!selectedFile) return;
    uploadMutation.mutate(selectedFile);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileArchive className="h-4 w-4" />
            Импорт аккаунтов из ZIP
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
              transition-colors
              ${isDragging ? "border-blue-500 bg-blue-500/5" : "border-border hover:border-muted-foreground/50"}
              ${uploadMutation.isPending ? "pointer-events-none opacity-50" : ""}
            `}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
              disabled={uploadMutation.isPending}
            />
            <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            {selectedFile ? (
              <div>
                <p className="text-sm font-medium">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">Перетащите ZIP-файл сюда</p>
                <p className="text-xs text-muted-foreground mt-1">
                  или нажмите для выбора файла
                </p>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Загрузите ZIP-архив с файлами .session и .json
          </p>

          {/* Result display */}
          {result && (
            <div className="bg-muted/30 rounded-lg p-3 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-emerald-500 font-semibold">
                  Импортировано: {result.imported}
                </span>
                <span className="text-yellow-500 font-semibold">
                  Пропущено: {result.skipped}
                </span>
                <span className="text-red-500 font-semibold">
                  Ошибок: {result.errors}
                </span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={uploadMutation.isPending}
          >
            {result ? "Закрыть" : "Отмена"}
          </Button>
          {!result && (
            <Button
              onClick={handleSubmit}
              disabled={!selectedFile || uploadMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {uploadMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Импортировать
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
