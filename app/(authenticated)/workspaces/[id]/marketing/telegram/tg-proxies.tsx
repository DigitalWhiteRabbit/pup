"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Globe,
  Plus,
  Search,
  Loader2,
  Upload,
  Trash2,
  Wifi,
  CheckCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import { toastSuccess, toastApiError } from "@/lib/toast";
import {
  type TgSectionProps,
  tgApi,
  tgFetch,
  tgPost,
  tgDelete,
  ProxyStatusBadge,
  ProxyTypeBadge,
  EmptyState,
  formatDate,
} from "./tg-shared";

// ── Filter options ──

const PROXY_STATUSES = ["ALL", "ACTIVE", "DEAD", "PAUSED", "EXPIRED"] as const;
const PROXY_TYPES = ["ALL", "SOCKS5", "HTTP", "HTTPS", "MTPROTO"] as const;

const STATUS_LABELS: Record<string, string> = {
  ALL: "Все статусы",
  ACTIVE: "Активные",
  DEAD: "Мёртвые",
  PAUSED: "На паузе",
  EXPIRED: "Истёкшие",
};

const TYPE_LABELS: Record<string, string> = {
  ALL: "Все типы",
  SOCKS5: "SOCKS5",
  HTTP: "HTTP",
  HTTPS: "HTTPS",
  MTPROTO: "MTProto",
};

// ── Main component ──

export function ProxiesSection({ workspaceId }: TgSectionProps) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const pageSize = 25;

  const queryParams = new URLSearchParams();
  queryParams.set("limit", String(pageSize));
  queryParams.set("offset", String(page * pageSize));
  if (statusFilter !== "ALL") queryParams.set("status", statusFilter);
  if (typeFilter !== "ALL") queryParams.set("type", typeFilter);
  if (search.trim()) queryParams.set("search", search.trim());

  const { data, isLoading } = useQuery({
    queryKey: [
      "tg-proxies",
      workspaceId,
      statusFilter,
      typeFilter,
      search,
      page,
    ],
    queryFn: () =>
      tgFetch(tgApi(workspaceId, `/proxies?${queryParams.toString()}`)),
  });

  const proxies: any[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  const [checkingProxyId, setCheckingProxyId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tgDelete(tgApi(workspaceId, `/proxies/${id}`)),
    onSuccess: () => {
      toastSuccess("Прокси удалён");
      queryClient.invalidateQueries({
        queryKey: ["tg-proxies", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const checkAllMutation = useMutation({
    mutationFn: () => tgPost(tgApi(workspaceId, "/proxies/check-all")),
    onSuccess: (data: any) => {
      toastSuccess(
        `Проверка завершена: ${data?.checked ?? 0} проверено, ${data?.alive ?? 0} активных`,
      );
      queryClient.invalidateQueries({
        queryKey: ["tg-proxies", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const checkSingleMutation = useMutation({
    mutationFn: (id: string) => {
      setCheckingProxyId(id);
      return tgPost(tgApi(workspaceId, `/proxies/${id}/check`));
    },
    onSuccess: (data: any) => {
      setCheckingProxyId(null);
      const status = data?.status || "unknown";
      const ping = data?.ping_ms != null ? ` (${data.ping_ms}ms)` : "";
      toastSuccess(`Прокси: ${status}${ping}`);
      queryClient.invalidateQueries({
        queryKey: ["tg-proxies", workspaceId],
      });
    },
    onError: (err) => {
      setCheckingProxyId(null);
      toastApiError(err);
    },
  });

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
        <h2 className="text-lg font-extrabold">Прокси</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkAllMutation.mutate()}
            disabled={checkAllMutation.isPending}
          >
            {checkAllMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
            )}
            Проверить все
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBulkImport(true)}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Массовый импорт
          </Button>
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white"
            size="sm"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Добавить прокси
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
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            {PROXY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s] || s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={typeFilter}
          onValueChange={(v) => {
            setTypeFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Тип" />
          </SelectTrigger>
          <SelectContent>
            {PROXY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t] || t}
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
            placeholder="Поиск по хосту, провайдеру..."
            className="pl-9 text-sm"
          />
        </div>
        <div className="text-xs text-muted-foreground ml-auto">
          {total} прокси
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {proxies.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Хост:Порт
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Тип
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Провайдер
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Страна
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Статус
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Пинг
                    </th>
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground">
                      Истекает
                    </th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {proxies.map((proxy: any) => (
                    <tr
                      key={proxy.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-3 py-2.5 font-mono font-medium">
                        {proxy.host}:{proxy.port}
                      </td>
                      <td className="px-3 py-2.5">
                        <ProxyTypeBadge type={proxy.type || proxy.scheme} />
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {proxy.provider || "--"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {proxy.country || "--"}
                      </td>
                      <td className="px-3 py-2.5">
                        <ProxyStatusBadge status={proxy.status} />
                      </td>
                      <td className="px-3 py-2.5">
                        {proxy.last_ping_ms != null ? (
                          <span
                            className={`font-medium ${
                              proxy.last_ping_ms < 200
                                ? "text-emerald-500"
                                : proxy.last_ping_ms < 500
                                  ? "text-yellow-500"
                                  : "text-red-500"
                            }`}
                          >
                            {proxy.last_ping_ms}ms
                          </span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {formatDate(proxy.expires_at)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-blue-500"
                            onClick={() => checkSingleMutation.mutate(proxy.id)}
                            disabled={
                              checkSingleMutation.isPending &&
                              checkingProxyId === proxy.id
                            }
                            aria-label="Проверить прокси"
                            title="Проверить прокси"
                          >
                            {checkSingleMutation.isPending &&
                            checkingProxyId === proxy.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                            onClick={() => {
                              if (confirm("Удалить прокси?")) {
                                deleteMutation.mutate(proxy.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            aria-label="Удалить прокси"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={Globe}
              title="Нет прокси"
              description="Добавьте прокси для привязки к Telegram аккаунтам"
              action={
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={() => setShowCreate(true)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Добавить первый прокси
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
      <CreateProxyDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        workspaceId={workspaceId}
      />

      {/* Bulk Import Dialog */}
      <BulkImportDialog
        open={showBulkImport}
        onClose={() => setShowBulkImport(false)}
        workspaceId={workspaceId}
      />
    </div>
  );
}

// ── Create Proxy Dialog ──

function CreateProxyDialog({
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
    provider: "",
    type: "SOCKS5",
    scheme: "socks5",
    host: "",
    port: "",
    username: "",
    password: "",
    country: "",
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      tgPost(tgApi(workspaceId, "/proxies"), {
        ...data,
        port: parseInt(data.port) || 0,
      }),
    onSuccess: () => {
      toastSuccess("Прокси добавлен");
      queryClient.invalidateQueries({
        queryKey: ["tg-proxies", workspaceId],
      });
      handleClose();
    },
    onError: toastApiError,
  });

  function handleClose() {
    if (!createMutation.isPending) {
      setForm({
        provider: "",
        type: "SOCKS5",
        scheme: "socks5",
        host: "",
        port: "",
        username: "",
        password: "",
        country: "",
      });
      onClose();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.host.trim() || !form.port.trim()) return;
    createMutation.mutate(form);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Wifi className="h-4 w-4" />
            Добавить прокси
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
              Провайдер
            </label>
            <Input
              value={form.provider}
              onChange={(e) =>
                setForm((p) => ({ ...p, provider: e.target.value }))
              }
              placeholder="proxy6, brightdata..."
              className="text-sm"
              disabled={createMutation.isPending}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Тип
              </label>
              <Select
                value={form.type}
                onValueChange={(v) =>
                  setForm((p) => ({
                    ...p,
                    type: v,
                    scheme: v.toLowerCase(),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SOCKS5">SOCKS5</SelectItem>
                  <SelectItem value="HTTP">HTTP</SelectItem>
                  <SelectItem value="HTTPS">HTTPS</SelectItem>
                  <SelectItem value="MTPROTO">MTProto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Схема
              </label>
              <Select
                value={form.scheme}
                onValueChange={(v) => setForm((p) => ({ ...p, scheme: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="socks5">socks5</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                  <SelectItem value="https">https</SelectItem>
                  <SelectItem value="mtproto">mtproto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Хост *
              </label>
              <Input
                value={form.host}
                onChange={(e) =>
                  setForm((p) => ({ ...p, host: e.target.value }))
                }
                placeholder="123.45.67.89"
                className="text-sm"
                autoFocus
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Порт *
              </label>
              <Input
                value={form.port}
                onChange={(e) =>
                  setForm((p) => ({ ...p, port: e.target.value }))
                }
                placeholder="1080"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Логин
              </label>
              <Input
                value={form.username}
                onChange={(e) =>
                  setForm((p) => ({ ...p, username: e.target.value }))
                }
                placeholder="user"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Пароль
              </label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) =>
                  setForm((p) => ({ ...p, password: e.target.value }))
                }
                placeholder="pass"
                className="text-sm"
                disabled={createMutation.isPending}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
              Страна
            </label>
            <Input
              value={form.country}
              onChange={(e) =>
                setForm((p) => ({ ...p, country: e.target.value }))
              }
              placeholder="US"
              className="text-sm"
              disabled={createMutation.isPending}
            />
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
              disabled={
                !form.host.trim() ||
                !form.port.trim() ||
                createMutation.isPending
              }
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

// ── Bulk Import Dialog ──

function BulkImportDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [rawText, setRawText] = useState("");
  const [importType, setImportType] = useState("SOCKS5");
  const [provider, setProvider] = useState("");

  const importMutation = useMutation({
    mutationFn: async (lines: string[]) => {
      const proxies = lines
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(":");
          if (parts.length < 2) return null;
          return {
            host: parts[0],
            port: parseInt(parts[1] ?? "0") || 0,
            username: parts[2] || undefined,
            password: parts[3] || undefined,
            type: importType,
            scheme: importType.toLowerCase(),
            provider: provider || undefined,
          };
        })
        .filter(Boolean);

      if (proxies.length === 0)
        throw new Error("Нет валидных прокси для импорта");

      return tgPost(tgApi(workspaceId, "/proxies/bulk"), { proxies });
    },
    onSuccess: (data: any) => {
      toastSuccess(`Импортировано ${data?.imported ?? 0} прокси`);
      queryClient.invalidateQueries({
        queryKey: ["tg-proxies", workspaceId],
      });
      handleClose();
    },
    onError: toastApiError,
  });

  function handleClose() {
    if (!importMutation.isPending) {
      setRawText("");
      setProvider("");
      onClose();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const lines = rawText.split("\n");
    importMutation.mutate(lines);
  }

  const lineCount = rawText.split("\n").filter((l) => l.trim()).length;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Upload className="h-4 w-4" />
            Массовый импорт прокси
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Тип
              </label>
              <Select value={importType} onValueChange={setImportType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SOCKS5">SOCKS5</SelectItem>
                  <SelectItem value="HTTP">HTTP</SelectItem>
                  <SelectItem value="HTTPS">HTTPS</SelectItem>
                  <SelectItem value="MTPROTO">MTProto</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Провайдер
              </label>
              <Input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="proxy6"
                className="text-sm"
                disabled={importMutation.isPending}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1.5 block">
              Прокси (host:port:user:pass -- по одному на строку)
            </label>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={
                "123.45.67.89:1080:user:pass\n98.76.54.32:1080:user:pass\n11.22.33.44:1080"
              }
              className="min-h-[200px] text-sm font-mono resize-y"
              disabled={importMutation.isPending}
            />
            {lineCount > 0 && (
              <div className="text-[10px] text-muted-foreground mt-1">
                {lineCount} прокси для импорта
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={importMutation.isPending}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={lineCount === 0 || importMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {importMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Импортировать ({lineCount})
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
