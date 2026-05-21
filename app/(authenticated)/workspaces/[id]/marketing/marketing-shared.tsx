"use client";

import { Badge } from "@/components/ui/badge";

// ── Shared types ──

export type MarketingSectionProps = { workspaceId: string };

// ── API helpers ──

export const api = (workspaceId: string, path: string) =>
  `/api/workspaces/${workspaceId}/marketing${path}`;

export async function fetchApi(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function postApi(url: string, body?: unknown) {
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

export async function patchApi(url: string, body: unknown) {
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

// ── Badge helpers ──

const SOURCE_COLORS: Record<string, string> = {
  YOUTUBE: "bg-red-500/10 text-red-500 border-red-500/20",
  TELEGRAM: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  INSTAGRAM: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  FACEBOOK: "bg-blue-600/10 text-blue-600 border-blue-600/20",
  LINKEDIN: "bg-blue-700/10 text-blue-700 border-blue-700/20",
};

export function SourceBadge({ source }: { source: string }) {
  const cls =
    SOURCE_COLORS[source?.toUpperCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-xs font-bold uppercase ${cls}`}>
      {source}
    </Badge>
  );
}

const STATUS_COLORS: Record<string, string> = {
  new: "bg-muted text-muted-foreground",
  enriched: "bg-blue-500/10 text-blue-500",
  qualified: "bg-emerald-500/10 text-emerald-500",
  contacted: "bg-orange-500/10 text-orange-500",
  rejected: "bg-red-500/10 text-red-500",
  converted: "bg-emerald-500/10 text-emerald-500",
};

export function StatusBadge({ status }: { status: string }) {
  const cls =
    STATUS_COLORS[status?.toLowerCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-xs font-bold ${cls}`}>
      {status}
    </Badge>
  );
}

export function ScoreBadge({ score }: { score: string | number | null }) {
  if (!score && score !== 0)
    return <span className="text-muted-foreground">—</span>;
  const num = typeof score === "number" ? score : parseFloat(score);
  let cls = "bg-red-500/10 text-red-500";
  let label = "Low";
  if (num >= 0.75) {
    cls = "bg-emerald-500/10 text-emerald-500";
    label = "High";
  } else if (num >= 0.4) {
    cls = "bg-yellow-500/10 text-yellow-500";
    label = "Medium";
  }
  return (
    <Badge variant="outline" className={`text-xs font-bold ${cls}`}>
      {label}
    </Badge>
  );
}

// ── Dialogue Stage labels & colors ──

export const DIALOGUE_STAGES = [
  {
    value: "NOT_CONTACTED",
    label: "Не связывались",
    color: "bg-muted text-muted-foreground",
  },
  { value: "QUEUED", label: "В очереди", color: "bg-sky-500/10 text-sky-500" },
  {
    value: "AWAITING_REVIEW",
    label: "На ревью",
    color: "bg-amber-500/10 text-amber-500",
  },
  {
    value: "CONTACTED",
    label: "Отправлено",
    color: "bg-blue-500/10 text-blue-500",
  },
  {
    value: "AWAITING_REPLY",
    label: "Ожидание",
    color: "bg-orange-500/10 text-orange-500",
  },
  {
    value: "FOLLOWUP_1",
    label: "Follow-up 1",
    color: "bg-orange-600/10 text-orange-600",
  },
  {
    value: "FOLLOWUP_2",
    label: "Follow-up 2",
    color: "bg-orange-700/10 text-orange-700",
  },
  {
    value: "REPLIED",
    label: "Ответил",
    color: "bg-emerald-500/10 text-emerald-500",
  },
  {
    value: "NEGOTIATING",
    label: "Переговоры",
    color: "bg-purple-500/10 text-purple-500",
  },
  {
    value: "DEAL_PENDING",
    label: "Сделка",
    color: "bg-indigo-500/10 text-indigo-500",
  },
  {
    value: "WON",
    label: "Выиграно",
    color: "bg-emerald-600/10 text-emerald-600",
  },
  { value: "LOST", label: "Отказ", color: "bg-red-500/10 text-red-500" },
] as const;

const DIALOGUE_STAGE_MAP = Object.fromEntries(
  DIALOGUE_STAGES.map((s) => [s.value, s]),
);

export function dialogueStageLabel(stage: string): string {
  return DIALOGUE_STAGE_MAP[stage]?.label ?? stage;
}

export function dialogueStageColor(stage: string): string {
  return DIALOGUE_STAGE_MAP[stage]?.color ?? "bg-muted text-muted-foreground";
}

// ── Lead Status labels & colors ──

export const LEAD_STATUSES = [
  {
    value: "PENDING",
    label: "Ожидает",
    color: "bg-muted text-muted-foreground",
  },
  { value: "READY", label: "Готов", color: "bg-sky-500/10 text-sky-500" },
  {
    value: "IN_WORK",
    label: "В работе",
    color: "bg-orange-500/10 text-orange-500",
  },
  {
    value: "DONE",
    label: "Готово",
    color: "bg-emerald-500/10 text-emerald-500",
  },
  { value: "REJECTED", label: "Отклонён", color: "bg-red-500/10 text-red-500" },
] as const;

const LEAD_STATUS_MAP = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s.value, s]),
);

export function leadStatusLabel(status: string): string {
  return LEAD_STATUS_MAP[status]?.label ?? status;
}

export function leadStatusColor(status: string): string {
  return LEAD_STATUS_MAP[status]?.color ?? "bg-muted text-muted-foreground";
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

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
      <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-emerald-500" />
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mb-4">
        {description}
      </p>
      {action}
    </div>
  );
}

// ── Source list (used by Parsers & Leads) ──

export const SOURCES = [
  {
    key: "YOUTUBE",
    name: "YouTube",
    desc: "YouTube Data API v3 · Каналы, видео, контакты",
    color: "bg-red-500/10 text-red-500",
  },
  {
    key: "TELEGRAM",
    name: "Telegram",
    desc: "gramjs MTProto · Каналы, группы",
    color: "bg-blue-500/10 text-blue-500",
  },
  {
    key: "INSTAGRAM",
    name: "Instagram",
    desc: "Apify actor · Профили, посты, контакты",
    color: "bg-purple-500/10 text-purple-500",
  },
  {
    key: "FACEBOOK",
    name: "Facebook",
    desc: "Apify actor · Страницы, группы",
    color: "bg-blue-600/10 text-blue-600",
  },
  {
    key: "LINKEDIN",
    name: "LinkedIn",
    desc: "Apify actor · Профили, компании",
    color: "bg-blue-700/10 text-blue-700",
  },
];
