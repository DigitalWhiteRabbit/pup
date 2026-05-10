"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Pencil,
  History,
  Trash2,
  ChevronLeft,
  Copy,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownPreview } from "@/components/kb/MarkdownPreview";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type { KbArticleFull } from "@/lib/services/kb/article.service";

type Props = {
  article: KbArticleFull;
  workspaceId: string;
};

export function ArticleViewClient({ article, workspaceId }: Props) {
  const router = useRouter();
  const qc = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: () =>
      fetch(`/api/kb/articles/${article.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess("Статья удалена");
      router.push(`/workspaces/${workspaceId}/knowledge`);
    },
    onError: toastApiError,
  });

  const publishMut = useMutation({
    mutationFn: (isPublished: boolean) =>
      fetch(`/api/kb/articles/${article.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished }),
      }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess(
        article.isPublished ? "Статья стала черновиком" : "Статья опубликована",
      );
      router.refresh();
    },
    onError: toastApiError,
  });

  const duplicateMut = useMutation({
    mutationFn: () =>
      fetch(`/api/workspaces/${workspaceId}/kb/articles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${article.title} (копия)`,
          content: article.content,
          categoryId: article.categoryId,
          tagIds: article.tags.map((t) => t.id),
          isPublished: false,
        }),
      }).then((r) => r.json()),
    onSuccess: (copy: KbArticleFull) => {
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess("Создана копия статьи");
      router.push(`/workspaces/${workspaceId}/knowledge/${copy.id}/edit`);
    },
    onError: toastApiError,
  });

  function handleDelete() {
    if (confirm(`Удалить статью «${article.title}»?`)) deleteMut.mutate();
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
        <Link
          href={`/workspaces/${workspaceId}`}
          className="hover:text-foreground"
        >
          Workspace
        </Link>
        <span>/</span>
        <Link
          href={`/workspaces/${workspaceId}/knowledge`}
          className="hover:text-foreground"
        >
          База знаний
        </Link>
        <span>/</span>
        <span className="text-foreground truncate max-w-[200px]">
          {article.title}
        </span>
      </nav>

      {/* Action bar */}
      <div className="flex items-center gap-2 mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/workspaces/${workspaceId}/knowledge`)}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Назад
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            router.push(
              `/workspaces/${workspaceId}/knowledge/${article.id}/history`,
            )
          }
        >
          <History className="h-4 w-4 mr-1.5" />
          История ({article.versionsCount})
        </Button>
        <Button
          size="sm"
          onClick={() =>
            router.push(
              `/workspaces/${workspaceId}/knowledge/${article.id}/edit`,
            )
          }
        >
          <Pencil className="h-4 w-4 mr-1.5" />
          Редактировать
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="px-2">
              <FileText className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => duplicateMut.mutate()}>
              <Copy className="h-4 w-4 mr-2" />
              Дублировать
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => publishMut.mutate(!article.isPublished)}
            >
              {article.isPublished ? "Сделать черновиком" : "Опубликовать"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Header */}
      <div className="mb-6">
        {!article.isPublished && (
          <Badge variant="secondary" className="mb-2">
            Черновик
          </Badge>
        )}
        <h1 className="text-3xl font-bold mb-3">{article.title}</h1>

        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {article.author && (
            <span>
              Автор:{" "}
              <span className="text-foreground">{article.author.login}</span>
            </span>
          )}
          <span>
            Создано:{" "}
            {format(new Date(article.createdAt), "d MMM yyyy", { locale: ru })}
          </span>
          {article.lastEditedBy && (
            <span>
              Обновил:{" "}
              <span className="text-foreground">
                {article.lastEditedBy.login}
              </span>{" "}
              {format(new Date(article.updatedAt), "d MMM yyyy", {
                locale: ru,
              })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {article.category && (
            <Badge
              variant="outline"
              style={{
                borderColor: article.category.color,
                color: article.category.color,
              }}
            >
              {article.category.name}
            </Badge>
          )}
          {article.tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              style={{ borderColor: tag.color, color: tag.color }}
            >
              {tag.name}
            </Badge>
          ))}
          {article.sourceType === "FILE" && (
            <Badge variant="secondary">Источник: файл</Badge>
          )}
          {article.sourceType === "URL" && (
            <Badge variant="secondary">Источник: URL</Badge>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="rounded-lg border bg-card p-6">
        <MarkdownPreview source={article.content} />
      </div>
    </div>
  );
}
