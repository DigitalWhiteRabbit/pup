"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  Link as LinkIcon,
  ChevronLeft,
  FileText,
  Loader2,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownPreview } from "@/components/kb/MarkdownPreview";
import { toastSuccess, toastApiError } from "@/lib/toast";
import type { KbCategoryWithCount } from "@/lib/services/kb/category.service";
import type { KbTagItem } from "@/lib/services/kb/tag.service";
import type { KbArticleSummary } from "@/lib/services/kb/article.service";

const ACCEPTED_TYPES = ".pdf,.docx,.xlsx,.txt,.md";
const ACCEPTED_LABEL = "PDF, DOCX, XLSX, TXT, MD";

type Props = {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── File Tab ─────────────────────────────────────────────────────────────────

function FileTab({
  workspaceId,
  categories,
  tags,
}: {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [categoryId, setCategoryId] = useState<string>("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KbArticleSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }, []);

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (categoryId) formData.append("categoryId", categoryId);
      if (selectedTagIds.length)
        formData.append("tagIds", JSON.stringify(selectedTagIds));

      const res = await fetch(`/api/workspaces/${workspaceId}/kb/import/file`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Ошибка импорта");
      }
      const article = (await res.json()) as KbArticleSummary;
      setResult(article);
      toastSuccess(`Статья «${article.title}» создана`);
    } catch (err) {
      toastApiError(err);
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-green-600">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-medium">Импорт завершён</span>
        </div>
        <Card>
          <CardContent className="pt-4 space-y-2">
            <p className="font-semibold">{result.title}</p>
            <p className="text-sm text-muted-foreground line-clamp-3">
              {result.contentPreview}
            </p>
          </CardContent>
        </Card>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              router.push(`/workspaces/${workspaceId}/knowledge/${result.id}`)
            }
          >
            Перейти к статье
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setFile(null);
              setResult(null);
            }}
          >
            Импортировать ещё
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Dropzone */}
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/30 hover:border-primary/50"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        {file ? (
          <div className="space-y-1">
            <div className="flex items-center justify-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">{file.name}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Перетащите файл или нажмите для выбора
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Поддерживаемые форматы: {ACCEPTED_LABEL}
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setFile(f);
          }}
        />
      </div>

      {/* Options */}
      {file && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Категория</label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
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
            <div className="space-y-1">
              <label className="text-sm font-medium">Теги</label>
              <div className="flex flex-wrap gap-1 p-2 border rounded-md min-h-[36px]">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <Badge
                      key={tag.id}
                      variant={selected ? "default" : "outline"}
                      className="cursor-pointer text-xs"
                      style={
                        selected ? { backgroundColor: tag.color } : undefined
                      }
                      onClick={() =>
                        setSelectedTagIds((prev) =>
                          selected
                            ? prev.filter((id) => id !== tag.id)
                            : [...prev, tag.id],
                        )
                      }
                    >
                      {tag.name}
                    </Badge>
                  );
                })}
                {!tags.length && (
                  <span className="text-xs text-muted-foreground">
                    Нет тегов
                  </span>
                )}
              </div>
            </div>
          </div>

          <Button onClick={handleImport} disabled={loading} className="w-full">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Извлекаем текст…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Импортировать
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );
}

// ─── URL Tab ──────────────────────────────────────────────────────────────────

function UrlTab({
  workspaceId,
  categories,
  tags,
}: {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{
    title: string;
    content: string;
    finalUrl: string;
  } | null>(null);
  const [urlError, setUrlError] = useState<string>("");

  const validateUrl = (val: string) => {
    try {
      new URL(val);
      setUrlError("");
      return true;
    } catch {
      setUrlError("Введите корректный URL (начиная с http:// или https://)");
      return false;
    }
  };

  const handlePreview = async () => {
    if (!validateUrl(url)) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/kb/import/url/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        },
      );
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Ошибка загрузки URL");
      }
      const data = (await res.json()) as {
        title: string;
        content: string;
        finalUrl: string;
      };
      setPreview(data);
    } catch (err) {
      toastApiError(err);
    } finally {
      setPreviewing(false);
    }
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/kb/import/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          categoryId: categoryId || undefined,
          tagIds: selectedTagIds.length ? selectedTagIds : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Ошибка импорта");
      }
      const article = (await res.json()) as KbArticleSummary;
      toastSuccess(`Статья «${article.title}» импортирована`);
      router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`);
    } catch (err) {
      toastApiError(err);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Input
            placeholder="https://example.com/article"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError("");
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handlePreview();
            }}
          />
          {urlError && <p className="text-xs text-destructive">{urlError}</p>}
        </div>
        <Button
          variant="outline"
          onClick={handlePreview}
          disabled={!url || previewing}
        >
          {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Превью"}
        </Button>
      </div>

      {preview && (
        <>
          <Card>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{preview.title}</p>
                <a
                  href={preview.finalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 text-muted-foreground hover:text-primary" />
                </a>
              </div>
              <div className="max-h-48 overflow-y-auto text-sm border rounded-md p-3 bg-muted/30">
                <MarkdownPreview
                  source={
                    preview.content.slice(0, 500) +
                    (preview.content.length > 500 ? "…" : "")
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Категория</label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
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
            <div className="space-y-1">
              <label className="text-sm font-medium">Теги</label>
              <div className="flex flex-wrap gap-1 p-2 border rounded-md min-h-[36px]">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <Badge
                      key={tag.id}
                      variant={selected ? "default" : "outline"}
                      className="cursor-pointer text-xs"
                      style={
                        selected ? { backgroundColor: tag.color } : undefined
                      }
                      onClick={() =>
                        setSelectedTagIds((prev) =>
                          selected
                            ? prev.filter((id) => id !== tag.id)
                            : [...prev, tag.id],
                        )
                      }
                    >
                      {tag.name}
                    </Badge>
                  );
                })}
                {!tags.length && (
                  <span className="text-xs text-muted-foreground">
                    Нет тегов
                  </span>
                )}
              </div>
            </div>
          </div>

          <Button
            onClick={handleImport}
            disabled={importing}
            className="w-full"
          >
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Импортируем…
              </>
            ) : (
              <>
                <LinkIcon className="h-4 w-4 mr-2" />
                Импортировать
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function ImportClient({ workspaceId, categories, tags }: Props) {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={`/workspaces/${workspaceId}/knowledge`}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Назад к списку
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Импорт в базу знаний</h1>
        <p className="text-muted-foreground text-sm">
          Загрузите документы или импортируйте контент с URL
        </p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="file">
        <TabsList className="w-full">
          <TabsTrigger value="file" className="flex-1 gap-2">
            <Upload className="h-4 w-4" />
            Из файла
          </TabsTrigger>
          <TabsTrigger value="url" className="flex-1 gap-2">
            <LinkIcon className="h-4 w-4" />
            Из URL
          </TabsTrigger>
          <TabsTrigger value="crawl" className="flex-1 gap-2" disabled>
            <ExternalLink className="h-4 w-4" />
            Краулинг сайта
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="mt-4">
          <FileTab
            workspaceId={workspaceId}
            categories={categories}
            tags={tags}
          />
        </TabsContent>

        <TabsContent value="url" className="mt-4">
          <UrlTab
            workspaceId={workspaceId}
            categories={categories}
            tags={tags}
          />
        </TabsContent>

        <TabsContent value="crawl" className="mt-4">
          <div className="text-center py-12 text-muted-foreground">
            <ExternalLink className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Краулинг сайта</p>
            <p className="text-sm mt-1">Будет доступно в следующей итерации</p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
