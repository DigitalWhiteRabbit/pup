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
import { trackAction } from "@/lib/services/action-tracker";
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";
import type { KbArticleSummary } from "@/lib/services/kb/article.service";

type Props = {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
};

export function NewArticleClient({ workspaceId, categories, tags }: Props) {
  const router = useRouter();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  // "" = no category (sentinel mapping lives inside KbCategoryTagPicker).
  const [categoryId, setCategoryId] = useState<string>("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isPublished, setIsPublished] = useState(true);

  const createMut = useMutation({
    mutationFn: (data: {
      title: string;
      content: string;
      categoryId: string | null;
      tagIds: string[];
      isPublished: boolean;
    }) =>
      fetch(`/api/workspaces/${workspaceId}/kb/articles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: (article: KbArticleSummary) => {
      trackAction(
        "knowledge:article:create",
        `knowledge:article:create`,
        article.title,
      );
      void qc.invalidateQueries({ queryKey: ["kb-articles", workspaceId] });
      toastSuccess("Статья создана");
      router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`);
    },
    onError: toastApiError,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createMut.mutate({
      title: title.trim(),
      content,
      categoryId: categoryId || null,
      tagIds: selectedTagIds,
      isPublished,
    });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/workspaces/${workspaceId}/knowledge`)}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Назад
        </Button>
        <h1 className="text-2xl font-bold">Новая статья</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Title */}
        <div className="space-y-1.5">
          <Label htmlFor="title">Заголовок *</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Введите заголовок статьи..."
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

        {/* Content */}
        <div className="space-y-1.5">
          <Label>Содержимое (Markdown)</Label>
          <MarkdownEditor value={content} onChange={setContent} height={450} />
        </div>

        {/* Published toggle */}
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPublished}
            onChange={(e) => setIsPublished(e.target.checked)}
            className="rounded"
          />
          Опубликовать статью
        </label>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={!title.trim() || createMut.isPending}>
            {createMut.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/workspaces/${workspaceId}/knowledge`)}
          >
            Отмена
          </Button>
        </div>
      </form>
    </div>
  );
}
