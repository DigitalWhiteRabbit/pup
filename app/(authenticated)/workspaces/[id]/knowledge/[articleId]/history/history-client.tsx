"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { ChevronLeft, Eye, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MarkdownPreview } from "@/components/kb/MarkdownPreview";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type {
  KbArticleFull,
  KbArticleVersionItem,
} from "@/lib/services/kb/article.service";

type Props = {
  article: KbArticleFull;
  history: KbArticleVersionItem[];
  workspaceId: string;
};

export function HistoryClient({ article, history, workspaceId }: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<KbArticleVersionItem | null>(null);

  const restoreMut = useMutation({
    mutationFn: (versionId: string) =>
      fetch(`/api/kb/articles/${article.id}/restore/${versionId}`, {
        method: "POST",
      }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess("Версия восстановлена");
      router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`);
    },
    onError: toastApiError,
  });

  function handleRestore(version: KbArticleVersionItem) {
    if (
      confirm(
        `Восстановить версию от ${format(new Date(version.editedAt), "d MMM yyyy, HH:mm", { locale: ru })}?`,
      )
    ) {
      restoreMut.mutate(version.id);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`)
          }
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Назад к статье
        </Button>
      </div>

      <h1 className="text-2xl font-bold mb-1">История изменений</h1>
      <p className="text-muted-foreground text-sm mb-6 truncate">
        «{article.title}»
      </p>

      {history.length === 0 ? (
        <p className="text-muted-foreground text-sm">История версий пуста.</p>
      ) : (
        <div className="relative space-y-0">
          {/* Timeline line */}
          <div className="absolute left-3.5 top-2 bottom-2 w-px bg-border" />

          {history.map((version, idx) => (
            <div key={version.id} className="relative flex gap-4 pb-6">
              <div className="w-7 h-7 rounded-full bg-background border-2 border-border flex items-center justify-center shrink-0 z-10 mt-0.5">
                <span className="text-xs text-muted-foreground">
                  {history.length - idx}
                </span>
              </div>
              <div className="flex-1 rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-sm font-medium">
                      {format(new Date(version.editedAt), "d MMM yyyy, HH:mm", {
                        locale: ru,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {version.editedBy?.login ?? "Система"}
                      {version.reason && <> · {version.reason}</>}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setPreview(version)}
                    >
                      <Eye className="h-3.5 w-3.5 mr-1" />
                      Просмотр
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleRestore(version)}
                      disabled={restoreMut.isPending}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      Восстановить
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {version.contentPreview}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview dialog */}
      <Dialog
        open={!!preview}
        onOpenChange={(v) => {
          if (!v) setPreview(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {preview?.title} &mdash;{" "}
              {preview &&
                format(new Date(preview.editedAt), "d MMM yyyy, HH:mm", {
                  locale: ru,
                })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            {preview && <MarkdownPreview source={preview.contentPreview} />}
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (preview) handleRestore(preview);
              }}
              disabled={restoreMut.isPending}
            >
              <RotateCcw className="h-4 w-4 mr-1.5" />
              Восстановить эту версию
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
