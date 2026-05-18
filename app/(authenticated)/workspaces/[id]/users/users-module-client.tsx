"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Plug,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Trash2,
  ChevronDown,
  Copy,
  Shield,
} from "lucide-react";
import { toastSuccess, toastError } from "@/lib/toast";
import { UsersSection } from "@/components/users/users-section";

type Config = {
  id: string;
  apiEndpoint: string;
  authType: string;
  isConnected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
};

type Props = { workspaceId: string };

export function UsersModuleClient({ workspaceId }: Props) {
  const base = `/api/workspaces/${workspaceId}/external-users`;

  const { data, isLoading } = useQuery<{ config: Config | null }>({
    queryKey: ["external-users-config", workspaceId],
    queryFn: () => fetch(base).then((r) => r.json()),
  });

  const config = data?.config;
  const isConnected = config?.isConnected;

  // If connected — show Users section
  if (isConnected) {
    return (
      <div className="flex flex-col h-full">
        {/* Connection status bar */}
        <div className="px-6 py-2 border-b border-border bg-card flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-emerald-500">
            <CheckCircle className="h-3.5 w-3.5" />
            API подключён
          </div>
          <span className="text-[10px] text-muted-foreground truncate">
            {config?.apiEndpoint}
          </span>
          {config?.lastSyncAt && (
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              Синхр.: {new Date(config.lastSyncAt).toLocaleTimeString("ru-RU")}
            </span>
          )}
          <DisconnectButton workspaceId={workspaceId} />
        </div>

        {/* Users Section from colleague's code */}
        <div className="flex-1 overflow-y-auto">
          <UsersSection workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Not connected — Welcome screen
  return (
    <WelcomeScreen workspaceId={workspaceId} existingConfig={config ?? null} />
  );
}

/* ── Welcome Screen ── */

function WelcomeScreen({
  workspaceId,
  existingConfig,
}: {
  workspaceId: string;
  existingConfig: Config | null;
}) {
  const qc = useQueryClient();
  const [endpoint, setEndpoint] = useState(existingConfig?.apiEndpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [authType, setAuthType] = useState(
    existingConfig?.authType ?? "bearer",
  );
  const [showDocs, setShowDocs] = useState(false);

  const connectMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/workspaces/${workspaceId}/external-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiEndpoint: endpoint.trim(),
          apiKey: apiKey.trim(),
          authType,
        }),
      });
      return res.json() as Promise<{
        isConnected: boolean;
        lastError: string | null;
      }>;
    },
    onSuccess: (data) => {
      if (data.isConnected) {
        toastSuccess("API успешно подключён!");
        void qc.invalidateQueries({
          queryKey: ["external-users-config", workspaceId],
        });
      } else {
        toastError(data.lastError ?? "Не удалось подключиться");
      }
    },
  });

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
          <Users className="h-8 w-8 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-2">
          Пользователи проекта
        </h1>
        <p className="text-muted-foreground">
          Подключите API вашего проекта для отображения пользователей. Мы будем
          получать данные напрямую из вашей базы.
        </p>
      </div>

      {/* Connection form */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-2">
          <Plug className="h-4 w-4 text-emerald-500" />
          Подключение API
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            API Endpoint (URL)
          </label>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-project.com/api/admin/users"
            className="w-full px-3 py-2.5 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-emerald-500 placeholder:text-muted-foreground/50"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full px-3 py-2.5 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-emerald-500 placeholder:text-muted-foreground/50"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Метод авторизации
          </label>
          <select
            value={authType}
            onChange={(e) => setAuthType(e.target.value)}
            className="w-full px-3 py-2.5 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-emerald-500"
          >
            <option value="bearer">Bearer Token (Authorization header)</option>
            <option value="x-api-key">X-API-Key (header)</option>
            <option value="query">Query Parameter (?apiKey=...)</option>
          </select>
        </div>

        {existingConfig?.lastError && (
          <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-500">
            <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {existingConfig.lastError}
          </div>
        )}

        <button
          onClick={() => connectMut.mutate()}
          disabled={!endpoint.trim() || !apiKey.trim() || connectMut.isPending}
          className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
        >
          {connectMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plug className="h-4 w-4" />
          )}
          {connectMut.isPending ? "Проверка подключения..." : "Подключить"}
        </button>
      </div>

      {/* API Documentation */}
      <div className="mt-6 rounded-xl border border-border bg-card overflow-hidden">
        <button
          onClick={() => setShowDocs((v) => !v)}
          className="w-full px-6 py-4 flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted/30 transition-colors"
        >
          <span className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            Инструкция для разработчика вашего проекта
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${showDocs ? "rotate-180" : ""}`}
          />
        </button>

        {showDocs && (
          <div className="px-6 pb-6 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground mb-4">
              Ваш проект должен предоставить REST API endpoint, который
              возвращает данные в следующем формате:
            </p>

            <div className="space-y-4">
              <DocSection
                title="GET /users"
                description="Список пользователей с пагинацией"
                params="?page=1&pageSize=50&search=ivan"
                response={`{
  "users": [
    {
      "id": "user-123",
      "name": "Иван Петров",
      "email": "ivan@example.com",
      "phone": "+7...",
      "registeredAt": "2024-01-15T10:00:00Z",
      "referrer": "user-456",
      "status": "active",
      "balance": 15000,
      "wallet": "0x...",
      "geo": "RU"
    }
  ],
  "total": 1500,
  "page": 1
}`}
              />

              <DocSection
                title="GET /snapshot"
                description="Общая статистика"
                response={`{
  "total": 11452,
  "activeWithDeposit": 3187,
  "newToday": 236,
  "newWeek": 1024,
  "online": 542
}`}
              />

              <DocSection
                title="GET /referrals/:userId"
                description="Реферальное дерево пользователя"
                response={`{
  "id": "user-123",
  "name": "Иван",
  "children": [
    { "id": "user-456", "name": "Петр", "children": [...] }
  ]
}`}
              />
            </div>

            <div className="mt-4 p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1">
                <Shield className="h-3.5 w-3.5" />
                Авторизация
              </div>
              <p className="text-[11px] text-muted-foreground">
                Каждый запрос будет содержать ваш API ключ в выбранном формате
                (Bearer token, X-API-Key header, или query parameter). Убедитесь
                что ваш API валидирует ключ.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Doc section helper ── */

function DocSection({
  title,
  description,
  params,
  response,
}: {
  title: string;
  description: string;
  params?: string;
  response: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="px-3 py-2 bg-muted/50 flex items-center justify-between">
        <div>
          <code className="text-xs font-mono font-bold text-emerald-500">
            {title}
          </code>
          {params && (
            <code className="text-[10px] font-mono text-muted-foreground ml-2">
              {params}
            </code>
          )}
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {description}
          </p>
        </div>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(response);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Копировать"
        >
          {copied ? (
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre className="px-3 py-2 text-[11px] font-mono text-muted-foreground overflow-auto max-h-[200px] bg-background">
        {response}
      </pre>
    </div>
  );
}

/* ── Disconnect button ── */

function DisconnectButton({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();

  return (
    <button
      onClick={async () => {
        if (!confirm("Отключить внешний API?")) return;
        await fetch(`/api/workspaces/${workspaceId}/external-users`, {
          method: "DELETE",
        });
        toastSuccess("API отключён");
        void qc.invalidateQueries({
          queryKey: ["external-users-config", workspaceId],
        });
      }}
      className="text-muted-foreground hover:text-red-400 transition-colors shrink-0"
      title="Отключить API"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
