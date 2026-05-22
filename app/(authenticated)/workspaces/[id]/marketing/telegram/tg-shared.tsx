"use client";

import { Badge } from "@/components/ui/badge";

// ── Shared types ──

export type TgSectionProps = { workspaceId: string };

// ── API helpers ──
// Proxied through Next.js: /api/workspaces/{id}/tg-service/...
// which forwards to localhost:8001/api/v1/...?workspace={id}

export const tgApi = (workspaceId: string, path: string) =>
  `/api/workspaces/${workspaceId}/tg-service${path}`;

export async function tgFetch(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function tgPost(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function tgPatch(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function tgDelete(url: string) {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `API error: ${res.status}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tgUpload(url: string, file: File): Promise<any> {
  const formData = new FormData();
  formData.append("file", file);
  // Do NOT set Content-Type — browser sets multipart boundary automatically
  const res = await fetch(url, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Upload error: ${res.status}`);
  }
  return res.json();
}

// ── Badge helpers ──

const ACCOUNT_STATUS_COLORS: Record<string, string> = {
  IMPORTED: "bg-muted text-muted-foreground",
  ACTIVE: "bg-emerald-500/10 text-emerald-500",
  WARMING: "bg-orange-500/10 text-orange-500",
  PAUSED: "bg-muted text-muted-foreground",
  FLOOD_WAIT: "bg-yellow-500/10 text-yellow-500",
  SPAM_BLOCKED: "bg-red-500/10 text-red-500",
  BANNED: "bg-red-500/10 text-red-500",
  DEAD: "bg-muted text-muted-foreground/50",
};

export function AccountStatusBadge({ status }: { status: string }) {
  const cls =
    ACCOUNT_STATUS_COLORS[status?.toUpperCase()] ||
    "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-xs font-bold ${cls}`}>
      {status}
    </Badge>
  );
}

const PROXY_STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-500",
  DEAD: "bg-red-500/10 text-red-500",
  PAUSED: "bg-muted text-muted-foreground",
  EXPIRED: "bg-yellow-500/10 text-yellow-500",
};

export function ProxyStatusBadge({ status }: { status: string }) {
  const cls =
    PROXY_STATUS_COLORS[status?.toUpperCase()] ||
    "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-xs font-bold ${cls}`}>
      {status}
    </Badge>
  );
}

const PROXY_TYPE_COLORS: Record<string, string> = {
  SOCKS5: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  HTTP: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  HTTPS: "bg-indigo-500/10 text-indigo-500 border-indigo-500/20",
  MTPROTO: "bg-sky-500/10 text-sky-500 border-sky-500/20",
};

export function ProxyTypeBadge({ type }: { type: string }) {
  const cls =
    PROXY_TYPE_COLORS[type?.toUpperCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-xs font-bold uppercase ${cls}`}>
      {type}
    </Badge>
  );
}

// ── Shared EmptyState ──

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-blue-500" />
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mb-4">
        {description}
      </p>
      {action}
    </div>
  );
}

// ── Utility helpers ──

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
