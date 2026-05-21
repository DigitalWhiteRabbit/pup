"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Plus,
  Trash2,
  Sparkles,
  Shield,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastSuccess, toastApiError } from "@/lib/toast";

type AgentConfig = {
  id: string;
  enabled: boolean;
  mode: string;
  model: string;
  temperature: number;
  systemPrompt: string | null;
  greeting: string | null;
  guardrails: string | null;
  handoffThreshold: number;
  autoResolve: boolean;
  autoFaq: boolean;
  autoContactNotes: boolean;
  useKnowledgeBase: boolean;
};

type Scenario = {
  id: string;
  title: string;
  description: string;
  instruction: string;
  enabled: boolean;
  position: number;
};

export function AgentSettingsClient({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"general" | "scenarios" | "guardrails">(
    "general",
  );

  // Config
  const { data: cfgData, isLoading: cfgLoading } = useQuery<{
    config: AgentConfig | null;
  }>({
    queryKey: ["agent-config", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/agent/config`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  // Scenarios
  const { data: scenData, isLoading: scenLoading } = useQuery<{
    data: Scenario[];
  }>({
    queryKey: ["agent-scenarios", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/agent/scenarios`);
      if (!r.ok) return { data: [] };
      return r.json();
    },
  });

  const cfg = cfgData?.config;
  const scenarios = scenData?.data ?? [];

  // Local state
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState("copilot");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [temperature, setTemperature] = useState("0.3");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [greeting, setGreeting] = useState("");
  const [guardrails, setGuardrails] = useState("");
  const [handoffThreshold, setHandoffThreshold] = useState("0.7");
  const [autoResolve, setAutoResolve] = useState(false);
  const [autoFaq, setAutoFaq] = useState(false);
  const [autoContactNotes, setAutoContactNotes] = useState(false);
  const [useKnowledgeBase, setUseKnowledgeBase] = useState(true);

  useEffect(() => {
    if (cfg) {
      setEnabled(cfg.enabled);
      setMode(cfg.mode);
      setModel(cfg.model);
      setTemperature(String(cfg.temperature));
      setSystemPrompt(cfg.systemPrompt ?? "");
      setGreeting(cfg.greeting ?? "");
      setGuardrails(cfg.guardrails ?? "");
      setHandoffThreshold(String(cfg.handoffThreshold));
      setAutoResolve(cfg.autoResolve);
      setAutoFaq(cfg.autoFaq);
      setAutoContactNotes(cfg.autoContactNotes);
      setUseKnowledgeBase(cfg.useKnowledgeBase);
    }
  }, [cfg]);

  const saveMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch(`/api/workspaces/${workspaceId}/agent/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agent-config", workspaceId] });
      toastSuccess("Настройки сохранены");
    },
    onError: toastApiError,
  });

  // Scenario create
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newInstr, setNewInstr] = useState("");

  const createScenMut = useMutation({
    mutationFn: (body: {
      title: string;
      description: string;
      instruction: string;
    }) =>
      fetch(`/api/workspaces/${workspaceId}/agent/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agent-scenarios", workspaceId] });
      setNewTitle("");
      setNewDesc("");
      setNewInstr("");
      toastSuccess("Сценарий создан");
    },
    onError: toastApiError,
  });

  const deleteScenMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/workspaces/${workspaceId}/agent/scenarios/${id}`, {
        method: "DELETE",
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agent-scenarios", workspaceId] });
      toastSuccess("Сценарий удалён");
    },
    onError: toastApiError,
  });

  if (cfgLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  const TABS = [
    { key: "general" as const, label: "Основные" },
    { key: "scenarios" as const, label: "Сценарии" },
    { key: "guardrails" as const, label: "Ограничения" },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">
            <Bot className="h-5 w-5 inline mr-1.5" />
            AI Агент
          </h1>
          <p className="text-sm text-muted-foreground">
            Copilot и Autopilot для поддержки
          </p>
        </div>
      </div>

      {/* Enable */}
      <div className="border rounded-xl p-4 mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              saveMut.mutate({ enabled: e.target.checked });
            }}
            className="w-4 h-4"
          />
          <div>
            <div className="text-sm font-medium">
              <Sparkles className="h-4 w-4 inline mr-1" />
              AI Агент активен
            </div>
            <div className="text-xs text-muted-foreground">
              Copilot подсказывает ответы менеджерам. Autopilot отвечает
              клиентам автоматически.
            </div>
          </div>
        </label>
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

      {/* General */}
      {tab === "general" && (
        <div className="space-y-4 max-w-lg">
          <div>
            <label className="text-sm font-medium mb-1 block">Режим</label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="copilot">
                  Copilot — подсказывает менеджерам
                </SelectItem>
                <SelectItem value="autopilot">
                  Autopilot — отвечает клиентам сам
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Модель</label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-sonnet-4-20250514">
                  Claude Sonnet 4 (рекомендуется)
                </SelectItem>
                <SelectItem value="claude-haiku-4-5-20251001">
                  Claude Haiku 4.5 (быстрый)
                </SelectItem>
                <SelectItem value="claude-opus-4-20250514">
                  Claude Opus 4 (мощный)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Температура ({temperature})
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Точный</span>
              <span>Креативный</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Системный промпт
            </label>
            <textarea
              className="w-full min-h-[120px] rounded-md border px-3 py-2 text-sm resize-y"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Ты — AI-помощник поддержки. Отвечай вежливо и по делу..."
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Порог handoff ({handoffThreshold})
            </label>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.1"
              value={handoffThreshold}
              onChange={(e) => setHandoffThreshold(e.target.value)}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Ниже этого порога — передаёт менеджеру
            </p>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <div className="text-sm font-medium">Автоматизация</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoResolve}
                onChange={(e) => setAutoResolve(e.target.checked)}
              />
              Авто-закрытие решённых тикетов
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoFaq}
                onChange={(e) => setAutoFaq(e.target.checked)}
              />
              Генерировать FAQ после закрытия
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoContactNotes}
                onChange={(e) => setAutoContactNotes(e.target.checked)}
              />
              Заметки о клиенте после закрытия
            </label>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <BookOpen className="h-4 w-4" />
              База знаний
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useKnowledgeBase}
                onChange={(e) => setUseKnowledgeBase(e.target.checked)}
              />
              Использовать базу знаний
            </label>
            <p className="text-xs text-muted-foreground">
              AI будет искать релевантные статьи и документы из базы знаний при
              ответе на вопросы клиентов.
            </p>
          </div>

          <Button
            onClick={() =>
              saveMut.mutate({
                mode,
                model,
                temperature: parseFloat(temperature),
                systemPrompt: systemPrompt || null,
                greeting: greeting || null,
                handoffThreshold: parseFloat(handoffThreshold),
                autoResolve,
                autoFaq,
                autoContactNotes,
                useKnowledgeBase,
              })
            }
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
        </div>
      )}

      {/* Scenarios */}
      {tab === "scenarios" && (
        <div className="space-y-4 max-w-lg">
          <p className="text-sm text-muted-foreground">
            Сценарии определяют как AI обрабатывает разные типы обращений.
            Каждый сценарий содержит инструкцию для агента.
          </p>

          {scenLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {scenarios.map((s) => (
                <div
                  key={s.id}
                  className="border rounded-lg p-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{s.title}</span>
                      <Badge variant="outline" className="text-xs">
                        #{s.position + 1}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.description}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2 font-mono">
                      {s.instruction}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive shrink-0"
                    onClick={() => deleteScenMut.mutate(s.id)}
                    disabled={deleteScenMut.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="border rounded-lg p-3 space-y-2">
            <div className="text-sm font-medium">Добавить сценарий</div>
            <Input
              placeholder="Название (Возврат товара)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <Input
              placeholder="Описание (Клиент хочет вернуть товар)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <textarea
              className="w-full min-h-[80px] rounded-md border px-3 py-2 text-sm resize-y"
              placeholder="Инструкция для AI: Уточни номер заказа, причину возврата..."
              value={newInstr}
              onChange={(e) => setNewInstr(e.target.value)}
            />
            <Button
              size="sm"
              disabled={
                !newTitle.trim() ||
                !newDesc.trim() ||
                !newInstr.trim() ||
                createScenMut.isPending
              }
              onClick={() =>
                createScenMut.mutate({
                  title: newTitle.trim(),
                  description: newDesc.trim(),
                  instruction: newInstr.trim(),
                })
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Добавить
            </Button>
          </div>
        </div>
      )}

      {/* Guardrails */}
      {tab === "guardrails" && (
        <div className="space-y-4 max-w-lg">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Ограничения которые AI никогда не нарушит. Одно правило на строку.
            </p>
          </div>

          <textarea
            className="w-full min-h-[200px] rounded-md border px-3 py-2 text-sm resize-y font-mono"
            value={guardrails}
            onChange={(e) => setGuardrails(e.target.value)}
            placeholder={`["Никогда не обсуждай цены конкурентов", "Не давай юридических советов", "Не запрашивай пароли и личные данные"]`}
          />
          <p className="text-xs text-muted-foreground">
            JSON-массив строк. Каждая строка — одно ограничение.
          </p>

          <Button
            onClick={() => saveMut.mutate({ guardrails: guardrails || null })}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? "Сохранение..." : "Сохранить ограничения"}
          </Button>
        </div>
      )}
    </div>
  );
}
