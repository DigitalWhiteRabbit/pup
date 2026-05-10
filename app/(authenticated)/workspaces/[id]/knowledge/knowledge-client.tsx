"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Plus,
  Settings2,
  Search,
  BookOpen,
  X,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
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
} from "@/components/ui/dialog";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type { KbArticleSummary } from "@/lib/services/kb/article.service";
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";

const PAGE_SIZE = 20;

// ─── Article Card ─────────────────────────────────────────────────────────────

function ArticleCard({
  article,
  workspaceId,
}: {
  article: KbArticleSummary;
  workspaceId: string;
}) {
  return (
    <Link href={`/workspaces/${workspaceId}/knowledge/${article.id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardContent className="p-4 flex flex-col gap-2 h-full">
          {article.category && (
            <div className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: article.category.color }}
              />
              <span className="text-xs text-muted-foreground truncate">
                {article.category.name}
              </span>
            </div>
          )}
          <h3 className="font-semibold text-sm leading-snug line-clamp-2">
            {article.title}
          </h3>
          {article.contentPreview && (
            <p className="text-xs text-muted-foreground line-clamp-3 flex-1">
              {article.contentPreview}
            </p>
          )}
          <div className="flex flex-wrap gap-1 mt-auto pt-1">
            {article.tags.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="outline"
                className="text-[10px] py-0 px-1.5"
                style={{ borderColor: tag.color, color: tag.color }}
              >
                {tag.name}
              </Badge>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
            <span>{article.author?.login ?? "—"}</span>
            <span>
              {formatDistanceToNow(new Date(article.updatedAt), {
                addSuffix: true,
                locale: ru,
              })}
            </span>
          </div>
          {!article.isPublished && (
            <Badge variant="secondary" className="text-[10px] self-start">
              Черновик
            </Badge>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function ArticleCardSkeleton() {
  return (
    <Card className="h-[180px]">
      <CardContent className="p-4 flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-1 mt-auto">
          <Skeleton className="h-4 w-12 rounded-full" />
          <Skeleton className="h-4 w-16 rounded-full" />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Sortable Category Row ─────────────────────────────────────────────────────

function SortableCategoryRow({
  cat,
  onEdit,
  onDelete,
}: {
  cat: KbCategoryWithCount;
  onEdit: (cat: KbCategoryWithCount) => void;
  onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cat.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-md border bg-card px-3 py-2"
    >
      <button
        {...attributes}
        {...listeners}
        className="text-muted-foreground cursor-grab"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span
        className="w-3 h-3 rounded-full shrink-0"
        style={{ backgroundColor: cat.color }}
      />
      <span className="flex-1 text-sm font-medium truncate">{cat.name}</span>
      <span className="text-xs text-muted-foreground">
        {cat.articlesCount} ст.
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => onEdit(cat)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive hover:text-destructive"
        onClick={() => onDelete(cat.id)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Category Dialog ──────────────────────────────────────────────────────────

function CategoryDialog({
  open,
  onOpenChange,
  workspaceId,
  categories,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  categories: KbCategoryWithCount[];
}) {
  const qc = useQueryClient();
  const [localCats, setLocalCats] = useState(categories);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("#6366f1");

  // Keep localCats in sync when parent changes
  useState(() => {
    setLocalCats(categories);
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const reorderMut = useMutation({
    mutationFn: (ids: string[]) =>
      fetch(`/api/workspaces/${workspaceId}/kb/categories/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryIds: ids }),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["kb-categories", workspaceId] }),
  });

  const createMut = useMutation({
    mutationFn: (data: { name: string; color: string }) =>
      fetch(`/api/workspaces/${workspaceId}/kb/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: (cat: KbCategoryWithCount) => {
      setLocalCats((prev) => [...prev, cat]);
      setNewName("");
      void qc.invalidateQueries({ queryKey: ["kb-categories", workspaceId] });
      toastSuccess("Категория создана");
    },
    onError: toastApiError,
  });

  const updateMut = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name: string; color: string };
    }) =>
      fetch(`/api/kb/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: (cat: KbCategoryWithCount) => {
      setLocalCats((prev) => prev.map((c) => (c.id === cat.id ? cat : c)));
      setEditId(null);
      void qc.invalidateQueries({ queryKey: ["kb-categories", workspaceId] });
      toastSuccess("Категория обновлена");
    },
    onError: toastApiError,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/kb/categories/${id}`, { method: "DELETE" }),
    onSuccess: (_r, id) => {
      setLocalCats((prev) => prev.filter((c) => c.id !== id));
      void qc.invalidateQueries({ queryKey: ["kb-categories", workspaceId] });
      toastSuccess("Категория удалена");
    },
    onError: toastApiError,
  });

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = localCats.findIndex((c) => c.id === active.id);
    const newIdx = localCats.findIndex((c) => c.id === over.id);
    const reordered = arrayMove(localCats, oldIdx, newIdx);
    setLocalCats(reordered);
    reorderMut.mutate(reordered.map((c) => c.id));
  }

  function startEdit(cat: KbCategoryWithCount) {
    setEditId(cat.id);
    setEditName(cat.name);
    setEditColor(cat.color);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Управление категориями</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-2 py-2">
          {localCats.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Категорий нет
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={localCats.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {localCats.map((cat) =>
                  editId === cat.id ? (
                    <div
                      key={cat.id}
                      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                    >
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        className="w-7 h-7 rounded cursor-pointer border-0 p-0"
                      />
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-sm flex-1"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          updateMut.mutate({
                            id: cat.id,
                            data: { name: editName, color: editColor },
                          })
                        }
                        disabled={!editName.trim() || updateMut.isPending}
                      >
                        Сохранить
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7"
                        onClick={() => setEditId(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <SortableCategoryRow
                      key={cat.id}
                      cat={cat}
                      onEdit={startEdit}
                      onDelete={(id) => {
                        if (confirm("Удалить категорию? Статьи сохранятся."))
                          deleteMut.mutate(id);
                      }}
                    />
                  ),
                )}
              </SortableContext>
            </DndContext>
          )}
        </div>

        <div className="border-t pt-3 flex items-center gap-2">
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="w-7 h-7 rounded cursor-pointer border-0 p-0"
          />
          <Input
            placeholder="Новая категория..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8 text-sm flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim())
                createMut.mutate({ name: newName.trim(), color: newColor });
            }}
          />
          <Button
            size="sm"
            className="h-8 shrink-0"
            onClick={() =>
              createMut.mutate({ name: newName.trim(), color: newColor })
            }
            disabled={!newName.trim() || createMut.isPending}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main client ──────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string;
  initialArticles: KbArticleSummary[];
  initialTotal: number;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
};

export function KnowledgeClient({
  workspaceId,
  initialArticles,
  initialTotal,
  categories: initCategories,
  tags: _tags,
}: Props) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showDrafts, setShowDrafts] = useState(false);
  const [catDialogOpen, setCatDialogOpen] = useState(false);

  const { data: categories } = useQuery<KbCategoryWithCount[]>({
    queryKey: ["kb-categories", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/kb/categories`).then((r) =>
        r.json(),
      ),
    initialData: initCategories,
    staleTime: 30_000,
  });

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (categoryFilter === "__none__") params.set("categoryId", "");
  else if (categoryFilter !== "all") params.set("categoryId", categoryFilter);
  if (!showDrafts) params.set("isPublished", "true");
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery<{
    data: KbArticleSummary[];
    total: number;
  }>({
    queryKey: [
      "kb-articles",
      workspaceId,
      page,
      categoryFilter,
      showDrafts,
      search,
    ],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/kb/articles?${params.toString()}`,
      ).then((r) => r.json()),
    initialData:
      page === 1 && !search && categoryFilter === "all" && !showDrafts
        ? { data: initialArticles, total: initialTotal }
        : undefined,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;
  const hasFilters = search || categoryFilter !== "all" || showDrafts;

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSearch(searchInput.trim());
      setPage(1);
    },
    [searchInput],
  );

  function reset() {
    setSearch("");
    setSearchInput("");
    setCategoryFilter("all");
    setShowDrafts(false);
    setPage(1);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">База знаний</h1>
          <p className="text-sm text-muted-foreground">
            Статьи и документация проекта
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCatDialogOpen(true)}
          >
            <Settings2 className="h-4 w-4 mr-1.5" />
            Категории
          </Button>
          <Button
            size="sm"
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/knowledge/new`)
            }
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Создать статью
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form className="flex items-center gap-2" onSubmit={handleSearch}>
          <Input
            placeholder="Поиск по заголовку..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-52 h-8"
          />
          <Button type="submit" variant="outline" size="sm" className="h-8">
            <Search className="h-3.5 w-3.5" />
          </Button>
        </form>

        <Select
          value={categoryFilter}
          onValueChange={(v) => {
            setCategoryFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44 h-8">
            <SelectValue placeholder="Все категории" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все категории</SelectItem>
            <SelectItem value="__none__">Без категории</SelectItem>
            {(categories ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDrafts}
            onChange={(e) => {
              setShowDrafts(e.target.checked);
              setPage(1);
            }}
            className="rounded"
          />
          Показывать черновики
        </label>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={reset}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            Сбросить
          </Button>
        )}
      </div>

      {data && (
        <p className="text-xs text-muted-foreground mb-3">
          {data.total} статей
        </p>
      )}

      {/* Articles grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <ArticleCardSkeleton key={i} />
          ))}
        </div>
      ) : !data || data.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground mb-4">Пока нет статей</p>
          <Button
            size="sm"
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/knowledge/new`)
            }
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Создать первую статью
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.data.map((a) => (
            <ArticleCard key={a.id} article={a} workspaceId={workspaceId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-6">
          <span className="text-sm text-muted-foreground">
            Страница {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}

      {/* Category dialog */}
      <CategoryDialog
        open={catDialogOpen}
        onOpenChange={setCatDialogOpen}
        workspaceId={workspaceId}
        categories={categories ?? []}
      />
    </div>
  );
}
