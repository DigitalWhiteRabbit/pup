"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { OverviewTab } from "./tabs/overview-tab";
import { UsersListTab } from "./tabs/users-list-tab";
import { ReferralTreeTab } from "./tabs/referral-tree-tab";
import { ActivityTab } from "./tabs/activity-tab";
import { WalletsTab } from "./tabs/wallets-tab";
import { OperationsHistoryTab } from "./tabs/operations-history-tab";
import { StatusesTab } from "./tabs/statuses-tab";
import { RisksTab } from "./tabs/risks-tab";
import { LogsTab } from "./tabs/logs-tab";

type TabId =
  | "overview"
  | "users"
  | "tree"
  | "activity"
  | "wallets"
  | "operations"
  | "statuses"
  | "risks"
  | "logs";

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Обзор" },
  { id: "users", label: "Список пользователей" },
  { id: "tree", label: "Реферальные деревья" },
  { id: "activity", label: "Регистрации и входы" },
  { id: "wallets", label: "Кошельки" },
  { id: "operations", label: "История операций" },
  { id: "statuses", label: "Карьерные статусы" },
  { id: "risks", label: "Риски" },
  { id: "logs", label: "Логи" },
];

export function UsersSection({ workspaceId }: { workspaceId: string }) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedUserId, setSelectedUserId] = useState<number>(0);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 lg:gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Пользователи</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Динамика проекта, рефералы, кошельки, карьерные статусы и действия
          администраторов.
        </p>
      </div>

      <div className="-mx-4 w-auto min-w-0 max-w-full overflow-x-auto border-y border-border bg-background/70 px-4 py-3 lg:mx-0 lg:rounded-lg lg:border">
        <div className="inline-flex w-max max-w-full gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "h-10 rounded-md border px-4 text-sm font-medium transition",
                activeTab === tab.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-foreground hover:bg-accent",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" && <OverviewTab workspaceId={workspaceId} />}
      {activeTab === "users" && (
        <UsersListTab
          workspaceId={workspaceId}
          onSelectUser={setSelectedUserId}
          selectedUserId={selectedUserId}
        />
      )}
      {activeTab === "tree" && (
        <ReferralTreeTab
          workspaceId={workspaceId}
          selectedUserId={selectedUserId}
        />
      )}
      {activeTab === "activity" && <ActivityTab workspaceId={workspaceId} />}
      {activeTab === "wallets" && <WalletsTab workspaceId={workspaceId} />}
      {activeTab === "operations" && (
        <OperationsHistoryTab workspaceId={workspaceId} />
      )}
      {activeTab === "statuses" && <StatusesTab workspaceId={workspaceId} />}
      {activeTab === "risks" && <RisksTab workspaceId={workspaceId} />}
      {activeTab === "logs" && <LogsTab workspaceId={workspaceId} />}
    </div>
  );
}
