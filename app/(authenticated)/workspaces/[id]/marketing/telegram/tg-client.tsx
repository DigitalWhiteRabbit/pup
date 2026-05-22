"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Users, Globe, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { tgApi, tgFetch } from "./tg-shared";

// ── Lazy-loaded section components ──

const DashboardSection = dynamic(
  () => import("./tg-dashboard").then((m) => ({ default: m.DashboardSection })),
  { loading: () => <SectionSkeleton /> },
);

const AccountsSection = dynamic(
  () => import("./tg-accounts").then((m) => ({ default: m.AccountsSection })),
  { loading: () => <SectionSkeleton /> },
);

const ProxiesSection = dynamic(
  () => import("./tg-proxies").then((m) => ({ default: m.ProxiesSection })),
  { loading: () => <SectionSkeleton /> },
);

const SettingsSection = dynamic(
  () => import("./tg-settings").then((m) => ({ default: m.SettingsSection })),
  { loading: () => <SectionSkeleton /> },
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

const TG_SECTIONS = [
  { key: "dashboard", label: "Дашборд", icon: LayoutDashboard },
  { key: "accounts", label: "Аккаунты", icon: Users },
  { key: "proxies", label: "Прокси", icon: Globe },
  { key: "settings", label: "Настройки", icon: Settings },
] as const;

// ── Main component ──

type Props = { workspaceId: string };

export function TgServiceClient({ workspaceId }: Props) {
  const [section, setSection] = useState<string>("dashboard");

  const { data: healthStatus } = useQuery({
    queryKey: ["tg-health", workspaceId],
    queryFn: () =>
      tgFetch(tgApi(workspaceId, "/health")).catch(() => ({
        status: "offline",
      })),
    refetchInterval: 15000,
  });

  const { data: accountStats } = useQuery({
    queryKey: ["tg-accounts-stats", workspaceId],
    queryFn: () =>
      tgFetch(tgApi(workspaceId, "/accounts/stats")).catch(() => ({})),
  });

  const isOnline =
    healthStatus?.status === "ok" || healthStatus?.status === "healthy";

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <div className="w-56 border-r bg-card flex flex-col shrink-0">
        <div className="p-4 border-b">
          <div className="text-xs font-bold uppercase text-muted-foreground tracking-widest">
            Модуль
          </div>
          <div className="text-lg font-extrabold text-blue-500">Телеграм</div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {TG_SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                section === s.key
                  ? "bg-blue-500/10 text-blue-500"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
              {s.key === "accounts" && (accountStats?.total ?? 0) > 0 && (
                <Badge variant="secondary" className="ml-auto text-xs px-1.5">
                  {accountStats.total}
                </Badge>
              )}
            </button>
          ))}
        </nav>
        {/* Service health footer */}
        <div className="p-3 border-t text-xs">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${
                isOnline
                  ? "bg-blue-500 animate-pulse"
                  : "bg-muted-foreground/30"
              }`}
            />
            <span className="text-muted-foreground">
              Сервис: {isOnline ? "Онлайн" : "Оффлайн"}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        {section === "dashboard" && (
          <DashboardSection workspaceId={workspaceId} onNavigate={setSection} />
        )}
        {section === "accounts" && (
          <AccountsSection workspaceId={workspaceId} />
        )}
        {section === "proxies" && <ProxiesSection workspaceId={workspaceId} />}
        {section === "settings" && (
          <SettingsSection workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
