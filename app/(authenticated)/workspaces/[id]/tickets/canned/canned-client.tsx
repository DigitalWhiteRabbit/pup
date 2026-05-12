"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Pencil, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastSuccess, toastApiError } from "@/lib/toast";

type CannedResponse = {
  id: string;
  shortCode: string;
  title: string;
  content: string;
  category: string | null;
};

export function CannedResponsesClient({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<CannedResponse | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ data: CannedResponse[] }>({
    queryKey: ["canned-responses", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/canned-responses`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/workspaces/${workspaceId}/canned-responses/${id}`, {
        method: "DELETE",
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["canned-responses", workspaceId],
      });
      toastSuccess("Шаблон удалён");
    },
    onError: toastApiError,
  });

  const items = data?.data ?? [];

  function handleCopy(content: string, id: string) {
    void navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold">Шаблоны ответов</h1>
          <p className="text-sm text-muted-foreground">
            Быстрые ответы по команде /код в чате
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Новый шаблон
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="mb-2">Шаблонов пока нет</p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Создать первый
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((cr) => (
            <div
              key={cr.id}
              className="border rounded-lg p-4 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                    /{cr.shortCode}
                  </code>
                  <span className="text-sm font-medium">{cr.title}</span>
                  {cr.category && (
                    <Badge variant="outline" className="text-[10px]">
                      {cr.category}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {cr.content}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleCopy(cr.content, cr.id)}
                >
                  {copiedId === cr.id ? (
                    <Check className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setEditItem(cr)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  onClick={() => deleteMut.mutate(cr.id)}
                  disabled={deleteMut.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CannedDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={workspaceId}
        mode="create"
      />
      {editItem && (
        <CannedDialog
          open={!!editItem}
          onOpenChange={() => setEditItem(null)}
          workspaceId={workspaceId}
          mode="edit"
          item={editItem}
        />
      )}
    </div>
  );
}

function CannedDialog({
  open,
  onOpenChange,
  workspaceId,
  mode,
  item,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  mode: "create" | "edit";
  item?: CannedResponse;
}) {
  const qc = useQueryClient();
  const [shortCode, setShortCode] = useState(item?.shortCode ?? "");
  const [title, setTitle] = useState(item?.title ?? "");
  const [content, setContent] = useState(item?.content ?? "");
  const [category, setCategory] = useState(item?.category ?? "");

  const mut = useMutation({
    mutationFn: (data: Record<string, unknown>) => {
      const url =
        mode === "create"
          ? `/api/workspaces/${workspaceId}/canned-responses`
          : `/api/workspaces/${workspaceId}/canned-responses/${item!.id}`;
      return fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["canned-responses", workspaceId],
      });
      toastSuccess(mode === "create" ? "Шаблон создан" : "Шаблон обновлён");
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Новый шаблон" : "Редактировать шаблон"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          {mode === "create" && (
            <div>
              <label className="text-sm font-medium mb-1 block">
                Код (без /)
              </label>
              <Input
                value={shortCode}
                onChange={(e) =>
                  setShortCode(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-zа-яё0-9_-]/gi, ""),
                  )
                }
                placeholder="привет"
                maxLength={50}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Менеджер набирает /{shortCode || "код"} в чате
              </p>
            </div>
          )}
          <div>
            <label className="text-sm font-medium mb-1 block">Название</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Приветствие"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Текст ответа
            </label>
            <textarea
              className="w-full min-h-[100px] rounded-md border px-3 py-2 text-sm resize-y"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Здравствуйте! Чем могу помочь?"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Категория (опц.)
            </label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Общие"
            />
          </div>
          <Button
            className="w-full"
            disabled={
              mut.isPending ||
              !title.trim() ||
              !content.trim() ||
              (mode === "create" && !shortCode.trim())
            }
            onClick={() =>
              mut.mutate({
                ...(mode === "create" ? { shortCode } : {}),
                title: title.trim(),
                content: content.trim(),
                category: category.trim() || null,
              })
            }
          >
            {mut.isPending
              ? "Сохранение..."
              : mode === "create"
                ? "Создать"
                : "Сохранить"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
