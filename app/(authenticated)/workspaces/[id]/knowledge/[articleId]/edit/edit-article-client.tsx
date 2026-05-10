"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Plus } from "lucide-react";
import { MarkdownEditor } from "@/components/kb/MarkdownEditor";
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
  const [categoryId, setCategoryId] = useState(article.categoryId ?? "");
  const [selectedTagIds, setSelectedTagIds] = useState(
    article.tags.map((t) => t.id),
  );
  const [isPublished, setIsPublished] = useState(article.isPublished);
  const [reason, setReason] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#8b5cf6");
  const [localTags, setLocalTags] = useState(tags);

  const createTagMut = useMutation({
    mutationFn: (data: { name: string; color: string }) =>
      fetch(`/api/workspaces/${workspaceId}/kb/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: (tag: KbTagItem) => {
      setLocalTags((prev) => [...prev, tag]);
      setSelectedTagIds((prev) => [...prev, tag.id]);
      setNewTagName("");
      void qc.invalidateQueries({ queryKey: ["kb-tags", workspaceId] });
    },
    onError: toastApiError,
  });

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

  function toggleTag(id: string) {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
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

        <div className="space-y-1.5">
          <Label>Категория</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Без категории" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Без категории</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Теги</Label>
          <div className="flex flex-wrap gap-2">
            {localTags.map((tag) => (
              <Badge
                key={tag.id}
                variant={
                  selectedTagIds.includes(tag.id) ? "default" : "outline"
                }
                className="cursor-pointer select-none"
                style={
                  selectedTagIds.includes(tag.id)
                    ? { backgroundColor: tag.color, border: "none" }
                    : { borderColor: tag.color, color: tag.color }
                }
                onClick={() => toggleTag(tag.id)}
              >
                {tag.name}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer border-0 p-0"
            />
            <Input
              placeholder="Новый тег..."
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              className="h-7 w-40 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newTagName.trim())
                    createTagMut.mutate({
                      name: newTagName.trim(),
                      color: newTagColor,
                    });
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={!newTagName.trim() || createTagMut.isPending}
              onClick={() => {
                if (newTagName.trim())
                  createTagMut.mutate({
                    name: newTagName.trim(),
                    color: newTagColor,
                  });
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

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
