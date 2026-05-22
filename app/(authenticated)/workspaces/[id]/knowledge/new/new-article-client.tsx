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
import { Plus, ChevronLeft } from "lucide-react";
import { MarkdownEditor } from "@/components/kb/MarkdownEditor";
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
  const [categoryId, setCategoryId] = useState<string>("__none__");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isPublished, setIsPublished] = useState(true);
  // New tag creation inline
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
      categoryId: categoryId === "__none__" ? null : categoryId || null,
      tagIds: selectedTagIds,
      isPublished,
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

        {/* Category */}
        <div className="space-y-1.5">
          <Label>Категория</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Без категории" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Без категории</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Tags */}
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
