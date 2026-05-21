"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Search,
  ArrowLeft,
  Globe,
  FileText,
  PenLine,
  X,
  SlidersHorizontal,
  Loader2,
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
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";
import type { SearchResult } from "@/lib/services/kb/search.service";
import type { SnippetSegment } from "@/lib/services/kb/utils";

// ─── Debounce hook ───────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// ─── Source type icon ────────────────────────────────────────────────────────

function SourceIcon({ type }: { type: string }) {
  if (type === "URL") return <Globe className="h-3.5 w-3.5" />;
  if (type === "FILE") return <FileText className="h-3.5 w-3.5" />;
  return <PenLine className="h-3.5 w-3.5" />;
}

// ─── Highlighted snippet renderer ────────────────────────────────────────────

function HighlightedSnippet({ segments }: { segments: SnippetSegment[] }) {
  return (
    <p className="text-sm text-muted-foreground leading-relaxed">
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark
            key={i}
            className="bg-yellow-200 dark:bg-yellow-900/60 text-foreground px-0.5 rounded-sm"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

// ─── Search result card ──────────────────────────────────────────────────────

function ResultCard({
  item,
  workspaceId,
}: {
  item: SearchResult["data"][number];
  workspaceId: string;
}) {
  return (
    <Link href={`/workspaces/${workspaceId}/knowledge/${item.id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {item.category && (
                  <Badge
                    variant="outline"
                    className="text-xs py-0 px-1.5 shrink-0"
                    style={{
                      borderColor: item.category.color,
                      color: item.category.color,
                    }}
                  >
                    {item.category.name}
                  </Badge>
                )}
                <div className="flex items-center gap-1 text-muted-foreground">
                  <SourceIcon type={item.sourceType} />
                </div>
              </div>
              <h3 className="font-semibold text-base leading-snug line-clamp-1">
                {item.title}
              </h3>
            </div>
          </div>

          <HighlightedSnippet segments={item.highlightedSnippet} />

          <div className="flex flex-wrap gap-1">
            {item.tags.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                variant="outline"
                className="text-xs py-0 px-1.5"
                style={{ borderColor: tag.color, color: tag.color }}
              >
                {tag.name}
              </Badge>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
            <span>{item.author?.login ?? "—"}</span>
            <span>
              {formatDistanceToNow(new Date(item.updatedAt), {
                addSuffix: true,
                locale: ru,
              })}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// ─── Main search client ──────────────────────────────────────────────────────

type Props = {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
};

export function SearchClient({ workspaceId, categories, tags }: Props) {
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";

  const [textInput, setTextInput] = useState(initialQ);
  const debouncedText = useDebounce(textInput, 300);

  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<string>("relevance");
  const [sortOrder, setSortOrder] = useState<string>("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Reset page when filters change
  useEffect(
    () => setPage(1),
    [
      debouncedText,
      categoryFilter,
      tagFilter,
      sourceTypeFilter,
      sortBy,
      showDrafts,
    ],
  );

  const searchBody = {
    text: debouncedText.length >= 2 ? debouncedText : undefined,
    page,
    pageSize: 20,
    categoryIds: categoryFilter.length ? categoryFilter : undefined,
    tagIds: tagFilter.length ? tagFilter : undefined,
    sourceTypes: sourceTypeFilter.length ? sourceTypeFilter : undefined,
    isPublished: showDrafts ? undefined : true,
    sortBy,
    sortOrder,
  };

  const shouldSearch =
    debouncedText.length >= 2 ||
    categoryFilter.length > 0 ||
    tagFilter.length > 0 ||
    sourceTypeFilter.length > 0;

  const { data, isLoading, isFetching } = useQuery<SearchResult>({
    queryKey: ["kb-search", workspaceId, searchBody],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/kb/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(searchBody),
      });
      if (!r.ok) throw new Error(`Search failed: ${r.status}`);
      return r.json() as Promise<SearchResult>;
    },
    enabled: shouldSearch,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  // Search history
  const { data: history } = useQuery<
    Array<{ query: string; resultCount: number; searchedAt: string }>
  >({
    queryKey: ["kb-search-history", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/kb/search`);
      if (!r.ok) return [];
      return r.json();
    },
    staleTime: 60_000,
  });

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  const hasFilters =
    categoryFilter.length > 0 ||
    tagFilter.length > 0 ||
    sourceTypeFilter.length > 0 ||
    showDrafts;

  const resetFilters = useCallback(() => {
    setTextInput("");
    setCategoryFilter([]);
    setTagFilter([]);
    setSourceTypeFilter([]);
    setShowDrafts(false);
    setSortBy("relevance");
    setPage(1);
  }, []);

  function toggleArrayItem(arr: string[], item: string): string[] {
    return arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item];
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/knowledge`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Поиск в Базе знаний</h1>
          <p className="text-sm text-muted-foreground">
            Полнотекстовый поиск по статьям, фильтры и сортировка
          </p>
        </div>
      </div>

      {/* Search bar */}
      <div className="sticky top-0 z-10 bg-background pb-4 border-b mb-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Поиск по статьям..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="pl-10 h-10"
              autoFocus
            />
            {textInput && (
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setTextInput("");
                  inputRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-10 gap-1.5"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Фильтры
            {hasFilters && (
              <span className="ml-1 bg-primary text-primary-foreground rounded-full w-5 h-5 text-xs flex items-center justify-center">
                {categoryFilter.length +
                  tagFilter.length +
                  sourceTypeFilter.length +
                  (showDrafts ? 1 : 0)}
              </span>
            )}
          </Button>
          <Select
            value={sortBy}
            onValueChange={(v) => {
              setSortBy(v);
              setSortOrder(v === "title" ? "asc" : "desc");
            }}
          >
            <SelectTrigger className="w-52 h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">По релевантности</SelectItem>
              <SelectItem value="updatedAt">По дате обновления</SelectItem>
              <SelectItem value="createdAt">По дате создания</SelectItem>
              <SelectItem value="title">По алфавиту</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Recent searches */}
        {!shouldSearch && history && history.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="text-xs text-muted-foreground pt-1">
              Недавние:
            </span>
            {history.slice(0, 5).map((h, i) => (
              <button
                key={i}
                className="text-xs px-2 py-1 rounded-full border bg-muted hover:bg-accent transition-colors"
                onClick={() => setTextInput(h.query)}
              >
                {h.query}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-6">
        {/* Filters sidebar */}
        {showFilters && (
          <div className="w-56 shrink-0 space-y-5">
            {/* Categories */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                Категории
              </h4>
              <div className="space-y-1">
                {categories.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={categoryFilter.includes(c.id)}
                      onChange={() =>
                        setCategoryFilter(toggleArrayItem(categoryFilter, c.id))
                      }
                    />
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: c.color }}
                    />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
                {categories.length === 0 && (
                  <p className="text-xs text-muted-foreground">Нет категорий</p>
                )}
              </div>
            </div>

            {/* Tags */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                Теги
              </h4>
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <button
                    key={t.id}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      tagFilter.includes(t.id)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-accent"
                    }`}
                    style={
                      !tagFilter.includes(t.id)
                        ? { borderColor: t.color, color: t.color }
                        : undefined
                    }
                    onClick={() =>
                      setTagFilter(toggleArrayItem(tagFilter, t.id))
                    }
                  >
                    {t.name}
                  </button>
                ))}
                {tags.length === 0 && (
                  <p className="text-xs text-muted-foreground">Нет тегов</p>
                )}
              </div>
            </div>

            {/* Source type */}
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                Тип источника
              </h4>
              <div className="space-y-1">
                {(
                  [
                    { key: "MANUAL", label: "Ручная" },
                    { key: "FILE", label: "Из файла" },
                    { key: "URL", label: "Из URL" },
                  ] as const
                ).map((s) => (
                  <label
                    key={s.key}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={sourceTypeFilter.includes(s.key)}
                      onChange={() =>
                        setSourceTypeFilter(
                          toggleArrayItem(sourceTypeFilter, s.key),
                        )
                      }
                    />
                    <SourceIcon type={s.key} />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Drafts toggle */}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={showDrafts}
                onChange={(e) => setShowDrafts(e.target.checked)}
              />
              Включая черновики
            </label>

            {/* Reset */}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={resetFilters}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Сбросить фильтры
              </Button>
            )}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 min-w-0">
          {!shouldSearch ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground">
                {textInput.length === 1
                  ? "Введите минимум 2 символа"
                  : "Введите запрос или выберите фильтры для поиска"}
              </p>
            </div>
          ) : isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : !data || data.data.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-2">Ничего не найдено</p>
              <p className="text-xs text-muted-foreground">
                Попробуйте изменить запрос или фильтры
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-muted-foreground">
                  {data.total} результат
                  {data.total === 1 ? "" : data.total < 5 ? "а" : "ов"}
                  {isFetching && (
                    <Loader2 className="h-3 w-3 animate-spin inline ml-2" />
                  )}
                </p>
              </div>

              <div className="space-y-3">
                {data.data.map((item) => (
                  <ResultCard
                    key={item.id}
                    item={item}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
