"use client";

import { useState, useRef } from "react";
import Image from "next/image";
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
  Camera,
  Loader2,
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
  scheduleDays: string | null;
};

const DAYS_OF_WEEK = [
  { value: 1, label: "Пн" },
  { value: 2, label: "Вт" },
  { value: 3, label: "Ср" },
  { value: 4, label: "Чт" },
  { value: 5, label: "Пт" },
  { value: 6, label: "Сб" },
  { value: 0, label: "Вс" },
];

function parseSchedule(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const TABS = [
  { key: "general", label: "Основные" },
  { key: "identity", label: "Идентификация" },
  { key: "personas", label: "Менеджеры" },
  { key: "schedule", label: "Расписание" },
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
                <PersonaCard
                  key={p.id}
                  persona={p}
                  workspaceId={workspaceId}
                  onDeleted={() =>
                    void qc.invalidateQueries({
                      queryKey: ["chat-personas", workspaceId],
                    })
                  }
                  onAvatarUploaded={() =>
                    void qc.invalidateQueries({
                      queryKey: ["chat-personas", workspaceId],
                    })
                  }
                  deleteDisabled={deletePersonaMut.isPending}
                  onDelete={() => deletePersonaMut.mutate(p.id)}
                />
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

      {/* Schedule tab */}
      {tab === "schedule" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Расписание смен — кто из менеджеров дежурит в какой день. По 2
            человека в смену.
          </p>

          {personasLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Сначала добавьте персон на вкладке &quot;Менеджеры&quot;
            </p>
          ) : (
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium w-40">
                      Менеджер
                    </th>
                    {DAYS_OF_WEEK.map((d) => (
                      <th
                        key={d.value}
                        className="px-2 py-2 text-center font-medium w-12"
                      >
                        {d.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {personas.map((p) => {
                    const schedule = parseSchedule(p.scheduleDays);
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {p.avatarUrl ? (
                              <Image
                                src={avatarSrc(p.avatarUrl)!}
                                alt=""
                                width={24}
                                height={24}
                                className="w-6 h-6 rounded-full object-cover"
                                unoptimized
                              />
                            ) : (
                              <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
                                {p.displayName[0]}
                              </div>
                            )}
                            <span className="text-xs font-medium">
                              {p.displayName}
                            </span>
                          </div>
                        </td>
                        {DAYS_OF_WEEK.map((d) => (
                          <td key={d.value} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={schedule.includes(d.value)}
                              onChange={async () => {
                                const newDays = schedule.includes(d.value)
                                  ? schedule.filter((v) => v !== d.value)
                                  : [...schedule, d.value];
                                await fetch(
                                  `/api/workspaces/${workspaceId}/chat/personas/${p.id}`,
                                  {
                                    method: "PATCH",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      scheduleDays: JSON.stringify(
                                        newDays.sort(),
                                      ),
                                    }),
                                  },
                                );
                                void qc.invalidateQueries({
                                  queryKey: ["chat-personas", workspaceId],
                                });
                              }}
                              className="rounded"
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Summary: who's on shift today */}
          {personas.length > 0 && (
            <div className="border rounded-xl p-4">
              <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                Сегодня на смене
              </div>
              <div className="flex gap-3">
                {personas
                  .filter((p) => {
                    const days = parseSchedule(p.scheduleDays);
                    if (days.length === 0) return false;
                    const today = new Date().getDay();
                    return days.includes(today);
                  })
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 bg-emerald-50 rounded-lg px-3 py-2"
                    >
                      {p.avatarUrl ? (
                        <Image
                          src={avatarSrc(p.avatarUrl)!}
                          alt=""
                          width={28}
                          height={28}
                          className="w-7 h-7 rounded-full object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-emerald-200 flex items-center justify-center text-xs font-bold text-emerald-700">
                          {p.displayName[0]}
                        </div>
                      )}
                      <div>
                        <div className="text-xs font-medium">
                          {p.displayName}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {p.role}
                        </div>
                      </div>
                    </div>
                  ))}
                {personas.filter((p) => {
                  const days = parseSchedule(p.scheduleDays);
                  return days.length > 0 && days.includes(new Date().getDay());
                }).length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Нет назначенных на сегодня. Настройте расписание выше.
                  </p>
                )}
              </div>
            </div>
          )}
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
                    {personas[0].avatarUrl ? (
                      <Image
                        src={`/api/chat/avatars/${personas[0].avatarUrl.replace(/^personas\//, "")}`}
                        alt=""
                        width={32}
                        height={32}
                        className="w-8 h-8 rounded-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center text-xs font-bold">
                        {personas[0].displayName[0]}
                      </div>
                    )}
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

// ─── PersonaCard ────────────────────────────────────────────────────────────

function avatarSrc(avatarUrl: string | null): string | null {
  if (!avatarUrl) return null;
  const path = avatarUrl.replace(/^personas\//, "");
  return `/api/chat/avatars/${path}`;
}

function PersonaCard({
  persona,
  workspaceId,
  onAvatarUploaded,
  deleteDisabled,
  onDelete,
}: {
  persona: Persona;
  workspaceId: string;
  onDeleted: () => void;
  onAvatarUploaded: () => void;
  deleteDisabled: boolean;
  onDelete: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleAvatarUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/workspaces/${workspaceId}/chat/personas/${persona.id}/avatar`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? "Ошибка загрузки",
        );
      }
      onAvatarUploaded();
      toastSuccess("Фото загружено");
    } catch (err) {
      toastApiError(err instanceof Error ? err : new Error("Ошибка"));
    } finally {
      setUploading(false);
    }
  }

  const src = avatarSrc(persona.avatarUrl);

  return (
    <div className="flex items-center gap-3 p-3 border rounded-lg">
      <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />

      {/* Аватар */}
      <button
        type="button"
        className="relative w-10 h-10 rounded-full shrink-0 bg-muted flex items-center justify-center overflow-hidden group"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        title="Загрузить фото"
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : src ? (
          <>
            <Image
              src={src}
              alt={persona.displayName}
              width={40}
              height={40}
              className="w-full h-full object-cover"
              unoptimized
            />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Camera className="h-4 w-4 text-white" />
            </div>
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm font-bold text-muted-foreground group-hover:hidden">
            {persona.displayName[0]}
          </div>
        )}
        {!src && !uploading && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-muted">
            <Camera className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleAvatarUpload(f);
            e.target.value = "";
          }}
        />
      </button>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{persona.displayName}</div>
        <div className="text-xs text-muted-foreground">{persona.role}</div>
      </div>
      <Badge variant="outline" className="text-[10px]">
        #{persona.position + 1}
      </Badge>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive"
        onClick={onDelete}
        disabled={deleteDisabled}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
