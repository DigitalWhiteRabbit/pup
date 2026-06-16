"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronLeft } from "lucide-react";
import { MarkdownEditor } from "@/components/kb/MarkdownEditor";
import { KbCategoryTagPicker } from "@/components/kb/KbCategoryTagPicker";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type {
  KbArticleFull,
  KbArticleSummary,
} from "@/lib/services/kb/article.service";
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";

type Props = {
  article: KbArticleFull;
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
};

export function EditArticleClient({
  article,
  workspaceId,
  categories,
  tags,
}: Props) {
  const router = useRouter();
  const qc = useQueryClient();

  const [title, setTitle] = useState(article.title);
  const [content, setContent] = useState(article.content);
  // "" = no category (sentinel mapping lives inside KbCategoryTagPicker).
  const [categoryId, setCategoryId] = useState(article.categoryId ?? "");
  const [selectedTagIds, setSelectedTagIds] = useState(
    article.tags.map((t) => t.id),
  );
  const [isPublished, setIsPublished] = useState(article.isPublished);
  const [reason, setReason] = useState("");

  const updateMut = useMutation({
    mutationFn: (data: object) =>
      fetch(`/api/kb/articles/${article.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: (updated: KbArticleSummary) => {
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess("Статья обновлена");
      router.push(`/workspaces/${workspaceId}/knowledge/${updated.id}`);
    },
    onError: toastApiError,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    updateMut.mutate({
      title: title.trim(),
      content,
      categoryId: categoryId || null,
      tagIds: selectedTagIds,
      isPublished,
      reason: reason.trim() || undefined,
    });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
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
        <h1 className="text-2xl font-bold">Редактирование</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="title">Заголовок *</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Заголовок статьи..."
            maxLength={200}
            required
          />
        </div>

        {/* Category + Tags */}
        <KbCategoryTagPicker
          workspaceId={workspaceId}
          categories={categories}
          tags={tags}
          categoryId={categoryId}
          onCategoryChange={setCategoryId}
          selectedTagIds={selectedTagIds}
          onTagsChange={setSelectedTagIds}
        />

        <div className="space-y-1.5">
          <Label>Содержимое (Markdown)</Label>
          <MarkdownEditor value={content} onChange={setContent} height={450} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="reason">Описание изменения (опционально)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Что изменилось?"
            maxLength={500}
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPublished}
            onChange={(e) => setIsPublished(e.target.checked)}
            className="rounded"
          />
          Опубликовать статью
        </label>

        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={!title.trim() || updateMut.isPending}>
            {updateMut.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`)
            }
          >
            Отмена
          </Button>
        </div>
      </form>
    </div>
  );
}
