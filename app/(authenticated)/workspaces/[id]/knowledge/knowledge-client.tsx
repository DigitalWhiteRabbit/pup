"use client";

import { formatFileSize } from "@/lib/utils";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DOMPurify from "dompurify";
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
  Upload,
  FileText,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileArchive,
  File,
  Download,
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
import type { KbFileView } from "@/lib/services/kb/file.service";
import type { SearchResult } from "@/lib/services/kb/search.service";
import type { SnippetSegment } from "@/lib/services/kb/utils";

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const PAGE_SIZE = 20;

// ─── File icon helper ─────────────────────────────────────────────────────────

function FileIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  if (mimeType.startsWith("image/")) return <FileImage className={className} />;
  if (mimeType.startsWith("video/")) return <FileVideo className={className} />;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  )
    return <FileSpreadsheet className={className} />;
  if (
    mimeType.includes("zip") ||
    mimeType.includes("archive") ||
    mimeType.includes("compressed")
  )
    return <FileArchive className={className} />;
  if (
    mimeType.includes("pdf") ||
    mimeType.includes("word") ||
    mimeType.includes("document") ||
    mimeType.includes("text")
  )
    return <FileText className={className} />;
  return <File className={className} />;
}

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
                className="text-xs py-0 px-1.5"
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
            <Badge variant="secondary" className="text-xs self-start">
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

  useEffect(() => {
    setLocalCats(categories);
  }, [categories]);

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

// ─── File Preview Modal ───────────────────────────────────────────────────────

type PreviewData =
  | { type: "text"; content: string }
  | { type: "html"; content: string }
  | { type: "image"; content: string }
  | { type: "unsupported"; content: string };

function FilePreviewModal({
  file,
  onClose,
}: {
  file: KbFileView;
  onClose: () => void;
}) {
  const { data, isPending, isError } = useQuery<PreviewData>({
    queryKey: ["kb-file-preview", file.id],
    queryFn: async () => {
      const res = await fetch(`/api/kb/files/${file.id}/preview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<PreviewData>;
    },
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

  const isUnsupported =
    isError || !data || !("type" in data) || data.type === "unsupported";

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 min-w-0 pr-6">
            <FileIcon
              mimeType={file.mimeType}
              className="h-5 w-5 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{file.originalName}</span>
          </DialogTitle>
          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-muted-foreground">
              {formatFileSize(file.size)} · {file.uploadedBy?.login ?? "—"} ·{" "}
              {formatDistanceToNow(new Date(file.uploadedAt), {
                addSuffix: true,
                locale: ru,
              })}
            </span>
            <a
              href={`/api/kb/files/${file.id}/download`}
              download={file.originalName}
            >
              <Button variant="outline" size="sm" className="h-7 text-xs">
                <Download className="h-3.5 w-3.5 mr-1" />
                Скачать
              </Button>
            </a>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto border rounded-md mt-2">
          {isPending ? (
            <div className="flex items-center justify-center h-48 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Загружаем содержимое...</span>
            </div>
          ) : isUnsupported ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <FileIcon
                mimeType={file.mimeType}
                className="h-10 w-10 opacity-30"
              />
              <p className="text-sm">
                Предпросмотр недоступен для этого типа файла
              </p>
              <a
                href={`/api/kb/files/${file.id}/download`}
                download={file.originalName}
              >
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-1.5" />
                  Скачать файл
                </Button>
              </a>
            </div>
          ) : data.type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.content}
              alt={file.originalName}
              className="max-w-full h-auto mx-auto block p-4"
            />
          ) : data.type === "html" ? (
            <div
              className="[&_p]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_strong]:font-semibold [&_em]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3 [&_li]:mb-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2 [&_th]:bg-muted p-6 text-sm leading-relaxed"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(data.content),
              }}
            />
          ) : (
            <pre className="p-6 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed">
              {data.content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Files Tab ────────────────────────────────────────────────────────────────

function FilesTab({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewFile, setPreviewFile] = useState<KbFileView | null>(null);

  const { data: files, isLoading } = useQuery<KbFileView[]>({
    queryKey: ["kb-files", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/kb/files`).then((r) => r.json()),
  });

  const uploadMut = useMutation({
    mutationFn: async (fileList: FileList) => {
      const results = [];
      for (const file of Array.from(fileList)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/workspaces/${workspaceId}/kb/files`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            (err as { message?: string }).message ?? "Ошибка загрузки",
          );
        }
        results.push(await res.json());
      }
      return results;
    },
    onSuccess: (results) => {
      void qc.invalidateQueries({ queryKey: ["kb-files", workspaceId] });
      toastSuccess(
        results.length === 1
          ? `Файл «${(results[0] as KbFileView).originalName}» загружен`
          : `Загружено файлов: ${results.length}`,
      );
    },
    onError: toastApiError,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/kb/files/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kb-files", workspaceId] });
      toastSuccess("Файл удалён");
    },
    onError: toastApiError,
  });

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    uploadMut.mutate(fileList);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDraggingOver
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
      >
        {uploadMut.isPending ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
            <p className="text-sm text-muted-foreground">Загрузка...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Перетащите файлы сюда</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                PDF, Word, Excel, изображения, архивы и любые другие форматы
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Выбрать файлы
            </Button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* File list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : !files || files.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          Нет загруженных документов
        </p>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/40 transition-colors cursor-pointer"
              onClick={() => setPreviewFile(f)}
            >
              <FileIcon
                mimeType={f.mimeType}
                className="h-5 w-5 text-muted-foreground shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{f.originalName}</p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(f.size)} · {f.uploadedBy?.login ?? "—"} ·{" "}
                  {formatDistanceToNow(new Date(f.uploadedAt), {
                    addSuffix: true,
                    locale: ru,
                  })}
                </p>
              </div>
              <a
                href={`/api/kb/files/${f.id}/download`}
                download={f.originalName}
                onClick={(e) => e.stopPropagation()}
              >
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Download className="h-4 w-4" />
                </Button>
              </a>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Удалить «${f.originalName}»?`))
                    deleteMut.mutate(f.id);
                }}
                disabled={deleteMut.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}

// ─── Mini Search ─────────────────────────────────────────────────────────

function MiniSearch({
  workspaceId,
  onApply,
}: {
  workspaceId: string;
  onApply: (q: string) => void;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const debounced = useDebounce(input, 300);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<SearchResult>({
    queryKey: ["kb-mini-search", workspaceId, debounced],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/kb/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: debounced,
          pageSize: 5,
          isPublished: true,
        }),
      }).then((r) => r.json()),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });

  // Close dropdown on click outside
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const showDropdown =
    open && debounced.length >= 2 && data && data.data.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(input.trim());
          setOpen(false);
        }}
      >
        <Input
          placeholder="Поиск по статьям..."
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="w-52 h-8"
        />
        <Button type="submit" variant="outline" size="sm" className="h-8">
          <Search className="h-3.5 w-3.5" />
        </Button>
      </form>

      {showDropdown && (
        <div className="absolute top-full left-0 mt-1 w-80 bg-popover border rounded-lg shadow-lg z-50 py-1">
          {data.data.map((item) => (
            <Link
              key={item.id}
              href={`/workspaces/${workspaceId}/knowledge/${item.id}`}
              className="block px-3 py-2 hover:bg-accent transition-colors"
              onClick={() => setOpen(false)}
            >
              <div className="flex items-center gap-2 mb-0.5">
                {item.category && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: item.category.color }}
                  />
                )}
                <span className="text-sm font-medium truncate">
                  {item.title}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-1">
                {item.highlightedSnippet
                  .map((s: SnippetSegment) => s.text)
                  .join("")
                  .slice(0, 80)}
              </p>
            </Link>
          ))}
          <div className="border-t mt-1 pt-1 px-3 py-1.5">
            <button
              className="text-xs text-primary hover:underline"
              onClick={() => {
                setOpen(false);
                router.push(
                  `/workspaces/${workspaceId}/knowledge/search?q=${encodeURIComponent(input)}`,
                );
              }}
            >
              Расширенный поиск →
            </button>
          </div>
        </div>
      )}
    </div>
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
  const [tab, setTab] = useState<"articles" | "files">("articles");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
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

  function reset() {
    setSearch("");
    setCategoryFilter("all");
    setShowDrafts(false);
    setPage(1);
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 md:gap-4 flex-wrap">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">База знаний</h1>
          <p className="text-sm text-muted-foreground">
            Статьи и документы проекта
          </p>
        </div>
        <div className="flex gap-2">
          {tab === "articles" && (
            <>
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
                variant="outline"
                onClick={() =>
                  router.push(`/workspaces/${workspaceId}/knowledge/import`)
                }
              >
                <Upload className="h-4 w-4 mr-1.5" />
                Импорт
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
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "articles"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setTab("articles")}
        >
          <BookOpen className="h-4 w-4 inline mr-1.5 -mt-0.5" />
          Статьи
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "files"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setTab("files")}
        >
          <FileText className="h-4 w-4 inline mr-1.5 -mt-0.5" />
          Документы
        </button>
      </div>

      {tab === "files" ? (
        <FilesTab workspaceId={workspaceId} />
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <MiniSearch
              workspaceId={workspaceId}
              onApply={(q) => {
                setSearch(q);
                setPage(1);
              }}
            />

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
        </>
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
