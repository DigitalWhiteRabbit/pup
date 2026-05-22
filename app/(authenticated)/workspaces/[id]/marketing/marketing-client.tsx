"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Search,
  Users,
  Settings,
  Send,
  Target,
  MessageCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api, fetchApi } from "./marketing-shared";

// ── Lazy-loaded section components ──

const DashboardSection = dynamic(
  () =>
    import("./marketing-dashboard").then((m) => ({
      default: m.DashboardSection,
    })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const ParsersSection = dynamic(
  () =>
    import("./marketing-parsers").then((m) => ({ default: m.ParsersSection })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const LeadsSection = dynamic(
  () => import("./marketing-leads").then((m) => ({ default: m.LeadsSection })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const CampaignsSection = dynamic(
  () =>
    import("./marketing-campaigns").then((m) => ({
      default: m.CampaignsSection,
    })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const AnalyticsSection = dynamic(
  () =>
    import("./marketing-analytics").then((m) => ({
      default: m.AnalyticsSection,
    })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const SettingsSection = dynamic(
  () =>
    import("./marketing-settings").then((m) => ({
      default: m.SettingsSection,
    })),
  {
    loading: () => <SectionSkeleton />,
  },
);

const TelegramSection = dynamic(
  () =>
    import("./telegram/tg-client").then((m) => ({
      default: m.TgServiceClient,
    })),
  {
    loading: () => <SectionSkeleton />,
  },
);

// ── Loading skeleton for sections ──

function SectionSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3.5">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

// ── Sidebar navigation ──

const SECTIONS = [
  { key: "dashboard", label: "Dashboard", icon: Target },
  { key: "parsers", label: "Парсеры", icon: Search },
  { key: "leads", label: "Лиды", icon: Users },
  { key: "campaigns", label: "Кампании", icon: Send },
  { key: "analytics", label: "Аналитика", icon: BarChart3 },
  { key: "telegram", label: "Telegram", icon: MessageCircle },
  { key: "settings", label: "Настройки", icon: Settings },
] as const;

// ── Main component ──

type Props = { workspaceId: string };

export function MarketingClient({ workspaceId }: Props) {
  const [section, setSection] = useState<string>("dashboard");

  const { data: workerStatus } = useQuery({
    queryKey: ["mkt-worker", workspaceId],
    queryFn: () =>
      fetchApi(api(workspaceId, "/worker")).catch(() => ({ running: false })),
    refetchInterval: 10000,
  });

  const { data: analytics } = useQuery({
    queryKey: ["mkt-analytics", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/analytics")).catch(() => ({})),
  });

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <div className="w-56 border-r bg-card flex flex-col shrink-0">
        <div className="p-4 border-b">
          <div className="text-xs font-bold uppercase text-muted-foreground tracking-widest">
            Модуль
          </div>
          <div className="text-lg font-extrabold text-emerald-500">
            Маркетинг
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                section === s.key
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
              {s.key === "leads" && (analytics?.totalLeads ?? 0) > 0 && (
                <Badge variant="secondary" className="ml-auto text-xs px-1.5">
                  {analytics.totalLeads}
                </Badge>
              )}
            </button>
          ))}
        </nav>
        {/* Worker status footer */}
        <div className="p-3 border-t text-xs">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${
                workerStatus?.running
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground/30"
              }`}
            />
            <span className="text-muted-foreground">
              Worker: {workerStatus?.running ? "Активен" : "Остановлен"}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        {section === "dashboard" && (
          <DashboardSection workspaceId={workspaceId} />
        )}
        {section === "parsers" && <ParsersSection workspaceId={workspaceId} />}
        {section === "leads" && <LeadsSection workspaceId={workspaceId} />}
        {section === "campaigns" && (
          <CampaignsSection workspaceId={workspaceId} />
        )}
        {section === "analytics" && (
          <AnalyticsSection workspaceId={workspaceId} />
        )}
        {section === "telegram" && (
          <TelegramSection workspaceId={workspaceId} />
        )}
        {section === "settings" && (
          <SettingsSection workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
