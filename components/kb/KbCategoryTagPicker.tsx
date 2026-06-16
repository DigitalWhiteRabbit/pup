"use client";

import { useState } from "react";
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
import { Plus, X } from "lucide-react";
import { toastApiError } from "@/lib/toast";
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";

/**
 * Shared "category + tags" picker for KB article create/edit/import flows.
 *
 * Both category and tag support INLINE creation (POST /kb/categories | /kb/tags)
 * with a freshly created item added to the local list and auto-selected.
 *
 * Sentinel handling lives ONLY here: Radix <Select> forbids an empty-string
 * <SelectItem> value, so internally "no category" is the sentinel NONE_CATEGORY;
 * the value exposed to callers via `categoryId` / `onCategoryChange` is the
 * CLEAN value — "" means "no category" — so downstream API logic
 * (categoryId || null / undefined) is identical everywhere.
 */

const NONE_CATEGORY = "__none__";
const DEFAULT_TAG_COLOR = "#8b5cf6";
const DEFAULT_CATEGORY_COLOR = "#6366f1";

type Props = {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
  /** "" = no category. */
  categoryId: string;
  onCategoryChange: (id: string) => void;
  selectedTagIds: string[];
  onTagsChange: (ids: string[]) => void;
};

export function KbCategoryTagPicker({
  workspaceId,
  categories,
  tags,
  categoryId,
  onCategoryChange,
  selectedTagIds,
  onTagsChange,
}: Props) {
  const qc = useQueryClient();

  // Local lists so inline-created items appear immediately.
  const [localCategories, setLocalCategories] = useState(categories);
  const [localTags, setLocalTags] = useState(tags);

  // New category inline form
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryColor, setNewCategoryColor] = useState(
    DEFAULT_CATEGORY_COLOR,
  );

  // New tag inline form
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLOR);

  const createCategoryMut = useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      const res = await fetch(`/api/workspaces/${workspaceId}/kb/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Не удалось создать категорию");
      }
      return (await res.json()) as KbCategoryWithCount;
    },
    onSuccess: (cat) => {
      setLocalCategories((prev) => [...prev, cat]);
      onCategoryChange(cat.id); // auto-select the new category
      setNewCategoryName("");
      setShowNewCategory(false);
      void qc.invalidateQueries({ queryKey: ["kb-categories", workspaceId] });
    },
    onError: toastApiError,
  });

  const createTagMut = useMutation({
    mutationFn: async (data: { name: string; color: string }) => {
      const res = await fetch(`/api/workspaces/${workspaceId}/kb/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Не удалось создать тег");
      }
      return (await res.json()) as KbTagItem;
    },
    onSuccess: (tag) => {
      setLocalTags((prev) => [...prev, tag]);
      onTagsChange([...selectedTagIds, tag.id]); // auto-select the new tag
      setNewTagName("");
      void qc.invalidateQueries({ queryKey: ["kb-tags", workspaceId] });
    },
    onError: toastApiError,
  });

  function submitNewCategory() {
    const name = newCategoryName.trim();
    if (!name || createCategoryMut.isPending) return;
    createCategoryMut.mutate({ name, color: newCategoryColor });
  }

  function submitNewTag() {
    const name = newTagName.trim();
    if (!name || createTagMut.isPending) return;
    createTagMut.mutate({ name, color: newTagColor });
  }

  function toggleTag(id: string) {
    onTagsChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((t) => t !== id)
        : [...selectedTagIds, id],
    );
  }

  return (
    <div className="space-y-4">
      {/* Category */}
      <div className="space-y-1.5">
        <Label>Категория</Label>
        <div className="flex items-center gap-2">
          <Select
            value={categoryId || NONE_CATEGORY}
            onValueChange={(v) =>
              onCategoryChange(v === NONE_CATEGORY ? "" : v)
            }
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Без категории" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_CATEGORY}>Без категории</SelectItem>
              {localCategories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 text-xs whitespace-nowrap"
            onClick={() => setShowNewCategory((v) => !v)}
          >
            {showNewCategory ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Создать
              </>
            )}
          </Button>
        </div>
        {showNewCategory && (
          <div className="flex items-center gap-2 pt-1">
            <input
              type="color"
              value={newCategoryColor}
              onChange={(e) => setNewCategoryColor(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer border-0 p-0"
              aria-label="Цвет категории"
            />
            <Input
              placeholder="Название категории..."
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              className="h-7 w-56 text-sm"
              maxLength={100}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitNewCategory();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={!newCategoryName.trim() || createCategoryMut.isPending}
              onClick={submitNewCategory}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="space-y-2">
        <Label>Теги</Label>
        <div className="flex flex-wrap gap-2">
          {localTags.map((tag) => {
            const selected = selectedTagIds.includes(tag.id);
            return (
              <Badge
                key={tag.id}
                variant={selected ? "default" : "outline"}
                className="cursor-pointer select-none"
                style={
                  selected
                    ? { backgroundColor: tag.color, border: "none" }
                    : { borderColor: tag.color, color: tag.color }
                }
                onClick={() => toggleTag(tag.id)}
              >
                {tag.name}
              </Badge>
            );
          })}
          {!localTags.length && (
            <span className="text-xs text-muted-foreground">Нет тегов</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            className="w-7 h-7 rounded cursor-pointer border-0 p-0"
            aria-label="Цвет тега"
          />
          <Input
            placeholder="Новый тег..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            className="h-7 w-40 text-sm"
            maxLength={50}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitNewTag();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!newTagName.trim() || createTagMut.isPending}
            onClick={submitNewTag}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
