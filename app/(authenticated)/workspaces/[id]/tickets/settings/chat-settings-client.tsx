"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Trash2,
  GripVertical,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toastSuccess, toastApiError } from "@/lib/toast";

type ChatSettings = {
  slug: string;
  chatTitle: string | null;
  chatSubtitle: string | null;
  chatAccentColor: string | null;
  chatLogoUrl: string | null;
  chatIdentityMethod: string;
  chatPersonaRotation: boolean;
  chatAllowedEmbedOrigins: string | null;
  chatTimezone: string;
};

type Persona = {
  id: string;
  displayName: string;
  role: string;
  bio: string | null;
  avatarUrl: string | null;
  position: number;
};

const TABS = [
  { key: "general", label: "Основные" },
  { key: "identity", label: "Идентификация" },
  { key: "personas", label: "Менеджеры" },
  { key: "widget", label: "Виджет" },
] as const;

const IDENTITY_METHODS = [
  {
    value: "EMAIL_WITH_NAME",
    label: "Email + Имя",
    desc: "Клиент указывает email и имя при первом обращении",
  },
  {
    value: "EMAIL_ONLY",
    label: "Только Email",
    desc: "Только email, без имени",
  },
  {
    value: "ANONYMOUS",
    label: "Анонимно",
    desc: "Без идентификации, только сессия",
  },
  {
    value: "TELEGRAM_LOGIN",
    label: "Telegram Login",
    desc: "Через Telegram Login Widget",
  },
];

export function ChatSettingsClient({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>("general");
  const [copied, setCopied] = useState(false);

  // Fetch settings
  const { data: settings, isLoading: settingsLoading } = useQuery<ChatSettings>(
    {
      queryKey: ["chat-settings", workspaceId],
      queryFn: async () => {
        const r = await fetch(`/api/workspaces/${workspaceId}/chat/settings`);
        if (!r.ok) throw new Error("Failed");
        return r.json();
      },
    },
  );

  // Fetch personas
  const { data: personasData, isLoading: personasLoading } = useQuery<{
    data: Persona[];
  }>({
    queryKey: ["chat-personas", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/chat/personas`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const personas = personasData?.data ?? [];

  // Local editable state
  const [title, setTitle] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const [identityMethod, setIdentityMethod] = useState<string | null>(null);
  const [rotation, setRotation] = useState<boolean | null>(null);
  const [embedOrigins, setEmbedOrigins] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);

  const currentTitle = title ?? settings?.chatTitle ?? "";
  const currentSubtitle = subtitle ?? settings?.chatSubtitle ?? "";
  const currentColor = accentColor ?? settings?.chatAccentColor ?? "#22c55e";
  const currentMethod =
    identityMethod ?? settings?.chatIdentityMethod ?? "EMAIL_WITH_NAME";
  const currentRotation = rotation ?? settings?.chatPersonaRotation ?? true;
  const currentOrigins =
    embedOrigins ?? settings?.chatAllowedEmbedOrigins ?? "";
  const currentTimezone = timezone ?? settings?.chatTimezone ?? "Europe/Moscow";

  // Save settings
  const saveMut = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetch(`/api/workspaces/${workspaceId}/chat/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["chat-settings", workspaceId],
      });
      toastSuccess("Настройки сохранены");
    },
    onError: toastApiError,
  });

  // Persona CRUD
  const [newPersonaName, setNewPersonaName] = useState("");
  const [newPersonaRole, setNewPersonaRole] = useState("");

  const createPersonaMut = useMutation({
    mutationFn: (data: { displayName: string; role: string }) =>
      fetch(`/api/workspaces/${workspaceId}/chat/personas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["chat-personas", workspaceId],
      });
      setNewPersonaName("");
      setNewPersonaRole("");
      toastSuccess("Персона создана");
    },
    onError: toastApiError,
  });

  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) =>
      fetch(`/api/workspaces/${workspaceId}/chat/personas/${personaId}`, {
        method: "DELETE",
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["chat-personas", workspaceId],
      });
      toastSuccess("Персона удалена");
    },
    onError: toastApiError,
  });

  const chatUrl = settings?.slug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/chat/${settings.slug}`
    : "";
  const embedCode = chatUrl
    ? `<iframe src="${chatUrl}?embed=1" width="400" height="600" frameborder="0"></iframe>`
    : "";

  function handleCopy(text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (settingsLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">Настройки чата</h1>
          <p className="text-sm text-muted-foreground">
            Публичный чат для клиентов
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* General tab */}
      {tab === "general" && (
        <div className="space-y-4 max-w-lg">
          <div>
            <label className="text-sm font-medium mb-1 block">
              Заголовок чата
            </label>
            <Input
              value={currentTitle}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Поддержка [название workspace]"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Подзаголовок
            </label>
            <Input
              value={currentSubtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Мы отвечаем быстро"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Цвет акцента
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={currentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                className="h-8 w-12 border rounded cursor-pointer"
              />
              <Input
                value={currentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                placeholder="#22c55e"
                className="w-28"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">
              Часовой пояс
            </label>
            <Input
              value={currentTimezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Moscow"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Используется для ротации персон
            </p>
          </div>
          <Button
            onClick={() =>
              saveMut.mutate({
                chatTitle: currentTitle || null,
                chatSubtitle: currentSubtitle || null,
                chatAccentColor: currentColor || null,
                chatTimezone: currentTimezone,
              })
            }
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
        </div>
      )}

      {/* Identity tab */}
      {tab === "identity" && (
        <div className="space-y-4 max-w-lg">
          <p className="text-sm text-muted-foreground">
            Как клиенты идентифицируются при начале чата
          </p>
          <div className="space-y-2">
            {IDENTITY_METHODS.map((m) => (
              <label
                key={m.value}
                className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                  currentMethod === m.value
                    ? "border-primary bg-primary/5"
                    : "hover:bg-accent/40"
                }`}
              >
                <input
                  type="radio"
                  name="identity"
                  value={m.value}
                  checked={currentMethod === m.value}
                  onChange={() => setIdentityMethod(m.value)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-xs text-muted-foreground">{m.desc}</div>
                </div>
              </label>
            ))}
          </div>
          <Button
            onClick={() =>
              saveMut.mutate({ chatIdentityMethod: currentMethod })
            }
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
        </div>
      )}

      {/* Personas tab */}
      {tab === "personas" && (
        <div className="space-y-4 max-w-lg">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Персоны менеджеров, отображаемые клиентам
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={currentRotation}
                onChange={(e) => {
                  setRotation(e.target.checked);
                  saveMut.mutate({ chatPersonaRotation: e.target.checked });
                }}
              />
              Ротация по дням
            </label>
          </div>

          {personasLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {personas.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 p-3 border rounded-lg"
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{p.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.role}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    #{p.position + 1}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    onClick={() => deletePersonaMut.mutate(p.id)}
                    disabled={deletePersonaMut.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="border rounded-lg p-3 space-y-2">
            <div className="text-sm font-medium">Добавить персону</div>
            <div className="flex gap-2">
              <Input
                placeholder="Имя (Алексей)"
                value={newPersonaName}
                onChange={(e) => setNewPersonaName(e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Роль (Поддержка)"
                value={newPersonaRole}
                onChange={(e) => setNewPersonaRole(e.target.value)}
                className="flex-1"
              />
            </div>
            <Button
              size="sm"
              disabled={
                !newPersonaName.trim() ||
                !newPersonaRole.trim() ||
                createPersonaMut.isPending
              }
              onClick={() =>
                createPersonaMut.mutate({
                  displayName: newPersonaName.trim(),
                  role: newPersonaRole.trim(),
                })
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Добавить
            </Button>
          </div>
        </div>
      )}

      {/* Widget tab */}
      {tab === "widget" && (
        <div className="space-y-4 max-w-lg">
          <div>
            <label className="text-sm font-medium mb-1 block">
              Публичная ссылка на чат
            </label>
            <div className="flex items-center gap-2">
              <Input value={chatUrl} readOnly className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => handleCopy(chatUrl)}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
              <a href={chatUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="icon" className="shrink-0">
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </a>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Код для вставки (iframe)
            </label>
            <textarea
              readOnly
              value={embedCode}
              className="w-full h-20 rounded-md border px-3 py-2 text-xs font-mono resize-none bg-muted"
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => handleCopy(embedCode)}
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              Копировать код
            </Button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Разрешённые домены для embed
            </label>
            <Input
              value={currentOrigins}
              onChange={(e) => setEmbedOrigins(e.target.value)}
              placeholder='["example.com", "app.example.com"] или пусто для всех'
            />
            <p className="text-xs text-muted-foreground mt-1">
              JSON-массив доменов. Пустое значение = любой домен.
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() =>
                saveMut.mutate({
                  chatAllowedEmbedOrigins: currentOrigins || null,
                })
              }
              disabled={saveMut.isPending}
            >
              Сохранить
            </Button>
          </div>

          {/* Preview */}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Превью чата
            </label>
            <div
              className="border rounded-lg overflow-hidden"
              style={{ maxWidth: 320 }}
            >
              <div
                className="p-4 text-white"
                style={{ backgroundColor: currentColor }}
              >
                <div className="text-lg font-bold">
                  {currentTitle || "Поддержка"}
                </div>
                <div className="text-sm opacity-80">
                  {currentSubtitle || "Мы отвечаем быстро"}
                </div>
                {personas.length > 0 && personas[0] && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center text-xs font-bold">
                      {personas[0].displayName[0]}
                    </div>
                    <div>
                      <div className="text-sm font-medium">
                        {personas[0].displayName}
                      </div>
                      <div className="text-xs opacity-70">
                        {personas[0].role}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="p-4 bg-gray-50 min-h-[120px]">
                <div className="flex justify-start mb-2">
                  <div className="bg-white border rounded-lg px-3 py-2 text-sm max-w-[80%]">
                    Здравствуйте! Чем могу помочь?
                  </div>
                </div>
                <div className="flex justify-end">
                  <div
                    className="rounded-lg px-3 py-2 text-sm text-white max-w-[80%]"
                    style={{ backgroundColor: currentColor }}
                  >
                    У меня вопрос...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
