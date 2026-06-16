"use client";

import { formatFileSize } from "@/lib/utils";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownPreview } from "@/components/kb/MarkdownPreview";
import { KbCategoryTagPicker } from "@/components/kb/KbCategoryTagPicker";
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

/** Char + word counter for collected content (preview volume hint). */
function countText(text: string): { chars: number; words: number } {
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { chars, words };
}

/**
 * Read a human-readable error from a non-OK response WITHOUT assuming JSON. A
 * cold-start/proxy/timeout can return an HTML error page; blindly calling
 * res.json() then threw "… is not valid JSON". Falls back to a clean message.
 */
async function readResponseError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const data = (await res.json()) as { error?: string };
      return data.error ?? `${fallback} (HTTP ${res.status})`;
    }
  } catch {
    /* non-JSON body — fall through */
  }
  return `${fallback} (HTTP ${res.status})`;
}

/** Parse a JSON success body, throwing a clean error if it isn't JSON. */
async function parseJsonOrThrow<T>(
  res: Response,
  fallback: string,
): Promise<T> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`${fallback} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
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
        throw new Error(await readResponseError(res, "Ошибка импорта"));
      }
      const article = await parseJsonOrThrow<KbArticleSummary>(
        res,
        "Ошибка импорта",
      );
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
              {formatFileSize(file.size)}
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
          <KbCategoryTagPicker
            workspaceId={workspaceId}
            categories={categories}
            tags={tags}
            categoryId={categoryId}
            onCategoryChange={setCategoryId}
            selectedTagIds={selectedTagIds}
            onTagsChange={setSelectedTagIds}
          />

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
        throw new Error(await readResponseError(res, "Ошибка загрузки URL"));
      }
      const data = await parseJsonOrThrow<{
        title: string;
        content: string;
        finalUrl: string;
      }>(res, "Ошибка загрузки URL");
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
        throw new Error(await readResponseError(res, "Ошибка импорта"));
      }
      const article = await parseJsonOrThrow<KbArticleSummary>(
        res,
        "Ошибка импорта",
      );
      toastSuccess(`Статья «${article.title}» импортирована`);
      router.push(`/workspaces/${workspaceId}/knowledge/${article.id}`);
    } catch (err) {
      toastApiError(err);
    } finally {
      setImporting(false);
    }
  };

  const counts = preview ? countText(preview.content) : null;

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
              {counts && (
                <p className="text-xs text-muted-foreground">
                  Собрано: {counts.chars.toLocaleString("ru")} символов · ~
                  {counts.words.toLocaleString("ru")} слов
                </p>
              )}
              {/* Full collected content, scrollable (no truncation). */}
              <div className="max-h-[28rem] overflow-y-auto text-sm border rounded-md p-3 bg-muted/30">
                <MarkdownPreview source={preview.content} />
              </div>
            </CardContent>
          </Card>

          <KbCategoryTagPicker
            workspaceId={workspaceId}
            categories={categories}
            tags={tags}
            categoryId={categoryId}
            onCategoryChange={setCategoryId}
            selectedTagIds={selectedTagIds}
            onTagsChange={setSelectedTagIds}
          />

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

// ─── Crawl Tab ────────────────────────────────────────────────────────────────

function CrawlTab({
  workspaceId,
  categories,
  tags,
}: {
  workspaceId: string;
  categories: KbCategoryWithCount[];
  tags: KbTagItem[];
}) {
  const router = useRouter();
  const [startUrl, setStartUrl] = useState("");
  const [maxPages, setMaxPages] = useState(500);
  const [maxDepth, setMaxDepth] = useState(5);
  const [timeoutMin, setTimeoutMin] = useState(15);
  const [categoryId, setCategoryId] = useState<string>("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [excludePathsRaw, setExcludePathsRaw] = useState("");
  const [showLimits, setShowLimits] = useState(false);
  const [loading, setLoading] = useState(false);
  const [urlError, setUrlError] = useState("");

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

  const handleStart = async () => {
    if (!validateUrl(startUrl)) return;
    setLoading(true);
    try {
      const excludePaths = excludePathsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch(
        `/api/workspaces/${workspaceId}/kb/import/crawl`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrl,
            maxPages,
            maxDepth,
            timeoutMs: timeoutMin * 60 * 1000,
            categoryId: categoryId || undefined,
            tagIds: selectedTagIds.length ? selectedTagIds : undefined,
            excludePaths: excludePaths.length ? excludePaths : undefined,
          }),
        },
      );
      if (!res.ok) {
        throw new Error(await readResponseError(res, "Ошибка запуска"));
      }
      const { crawlId } = await parseJsonOrThrow<{ crawlId: string }>(
        res,
        "Ошибка запуска",
      );
      toastSuccess("Crawl запущен");
      router.push(`/workspaces/${workspaceId}/knowledge/crawls/${crawlId}`);
    } catch (err) {
      toastApiError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">Стартовый URL</label>
        <Input
          placeholder="https://docs.example.com"
          value={startUrl}
          onChange={(e) => {
            setStartUrl(e.target.value);
            setUrlError("");
          }}
        />
        {urlError && <p className="text-xs text-destructive">{urlError}</p>}
        <p className="text-xs text-muted-foreground">
          Краулер обойдёт все страницы в пределах этого домена
        </p>
      </div>

      <button
        type="button"
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
        onClick={() => setShowLimits((v) => !v)}
      >
        {showLimits ? "▼" : "▶"} Лимиты и настройки
      </button>

      {showLimits && (
        <div className="grid grid-cols-3 gap-3 p-3 border rounded-md bg-muted/30">
          <div className="space-y-1">
            <label className="text-xs font-medium">Макс. страниц</label>
            <Input
              type="number"
              min={1}
              max={10000}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Макс. глубина</label>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxDepth}
              onChange={(e) => setMaxDepth(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Таймаут (мин)</label>
            <Input
              type="number"
              min={1}
              max={60}
              value={timeoutMin}
              onChange={(e) => setTimeoutMin(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1 col-span-3">
            <label className="text-xs font-medium">Исключить пути</label>
            <Input
              placeholder="/de, /fr, /tr"
              value={excludePathsRaw}
              onChange={(e) => setExcludePathsRaw(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Через запятую. Пропустить лишние локали/разделы (например
              /de,/fr,/tr) — оставить только нужные (корень = EN, /ru).
            </p>
          </div>
        </div>
      )}

      <KbCategoryTagPicker
        workspaceId={workspaceId}
        categories={categories}
        tags={tags}
        categoryId={categoryId}
        onCategoryChange={setCategoryId}
        selectedTagIds={selectedTagIds}
        onTagsChange={setSelectedTagIds}
      />

      <Button
        onClick={handleStart}
        disabled={!startUrl || loading}
        className="w-full"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Запускаем…
          </>
        ) : (
          <>
            <ExternalLink className="h-4 w-4 mr-2" />
            Запустить crawl
          </>
        )}
      </Button>
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
          <TabsTrigger value="crawl" className="flex-1 gap-2">
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
          <CrawlTab
            workspaceId={workspaceId}
            categories={categories}
            tags={tags}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
