"use client";

import Link from "next/link";
import { usePathname, useParams, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { MoscowClock } from "./MoscowClock";
import { OnlineUsers } from "./OnlineUsers";

const ThemeToggle = dynamic(
  () => import("./ThemeToggle").then((m) => m.ThemeToggle),
  { ssr: false, loading: () => <span className="w-7 h-7" /> },
);
import {
  LayoutDashboard,
  Settings,
  Users,
  LogOut,
  Menu,
  ChevronLeft,
  Kanban,
  BookOpen,
  Ticket,
  ScrollText,
  MessageSquare,
  Megaphone,
  BarChart3,
  ChevronsUpDown,
  Check,
  House,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
const NotificationBell = dynamic(
  () =>
    import("@/components/notifications/NotificationBell").then(
      (m) => m.NotificationBell,
    ),
  { ssr: false, loading: () => <span className="w-7 h-7" /> },
);
import type { ModuleKey } from "@/lib/services/workspace.service";

// ─── Module nav metadata ──────────────────────────────────────────────────────

type ModuleMeta = { label: string; icon: React.ReactNode };

const MODULE_META: Record<ModuleKey, ModuleMeta> = {
  crm: { label: "CRM-доска", icon: <Kanban className="h-4 w-4" /> },
  knowledge: { label: "База знаний", icon: <BookOpen className="h-4 w-4" /> },
  tickets: { label: "Тикеты", icon: <Ticket className="h-4 w-4" /> },
  logs: { label: "Логи", icon: <ScrollText className="h-4 w-4" /> },
  chat: { label: "Чат", icon: <MessageSquare className="h-4 w-4" /> },
  marketing: { label: "Маркетинг", icon: <Megaphone className="h-4 w-4" /> },
  analytics: { label: "Аналитика", icon: <BarChart3 className="h-4 w-4" /> },
  users: {
    label: "Пользователи проекта",
    icon: <Users className="h-4 w-4" />,
  },
};

const MODULE_ORDER: ModuleKey[] = [
  "crm",
  "knowledge",
  "tickets",
  "logs",
  "chat",
  "marketing",
  "analytics",
  "users",
];

// ─── API ──────────────────────────────────────────────────────────────────────

type ModuleState = { moduleKey: ModuleKey; enabled: boolean };

async function fetchModules(workspaceId: string): Promise<ModuleState[]> {
  const res = await fetch(`/api/workspaces/${workspaceId}/modules`);
  if (!res.ok) return [];
  return res.json() as Promise<ModuleState[]>;
}

async function fetchWorkspaceName(workspaceId: string): Promise<string> {
  const res = await fetch(`/api/workspaces/${workspaceId}`);
  if (!res.ok) return "";
  const data = (await res.json()) as { name: string };
  return data.name;
}

type WorkspaceSummary = { id: string; name: string };

async function fetchAllWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await fetch("/api/workspaces?limit=100");
  if (!res.ok) return [];
  const data = (await res.json()) as { data: WorkspaceSummary[] };
  return Array.isArray(data.data) ? data.data : [];
}

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  userLogin: string;
  userRole: "ADMIN" | "USER";
};

// ─── SidebarContent ───────────────────────────────────────────────────────────

function WorkspaceSwitcher({
  currentId,
  onNavigate,
}: {
  currentId: string | null;
  onNavigate?: () => void;
}) {
  const router = useRouter();

  const { data } = useQuery({
    queryKey: ["workspaces-switcher"],
    queryFn: fetchAllWorkspaces,
    staleTime: 0,
  });

  const workspaces: WorkspaceSummary[] = Array.isArray(data) ? data : [];
  const current = workspaces.find((w) => w.id === currentId);

  function handleSelect(id: string) {
    onNavigate?.();
    router.push(`/workspaces/${id}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent transition-colors max-w-[120px] w-full">
          <span className="flex-1 truncate text-left">
            {current?.name ?? "Проект..."}
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {workspaces.length === 0 ? (
          <p className="py-2 px-3 text-xs text-muted-foreground">
            Нет проектов
          </p>
        ) : (
          workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => handleSelect(w.id)}
              className="text-xs gap-2"
            >
              <Check
                className={`h-3 w-3 shrink-0 ${w.id === currentId ? "opacity-100" : "opacity-0"}`}
              />
              {w.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarContent({
  userLogin,
  userRole,
  onNavigate,
}: Props & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();

  // Contextual mode: /workspaces/[id]/*  (but NOT just /workspaces/[id] overview)
  const workspaceId = params?.id ?? null;
  const isContextual =
    !!workspaceId && pathname.startsWith(`/workspaces/${workspaceId}/`);

  const { data: modules, isLoading: modulesLoading } = useQuery({
    queryKey: ["workspace", workspaceId, "modules"],
    queryFn: () => fetchModules(workspaceId!),
    enabled: isContextual && !!workspaceId,
    staleTime: 30_000,
  });

  const { data: workspaceName } = useQuery({
    queryKey: ["workspace", workspaceId, "name"],
    queryFn: () => fetchWorkspaceName(workspaceId!),
    enabled: isContextual && !!workspaceId,
    staleTime: 60_000,
  });

  const enabledModules = (modules ?? [])
    .filter((m) => m.enabled)
    .map((m) => m.moduleKey);

  function handleLogout() {
    void signOut({ callbackUrl: "/login" });
  }

  function getInitials(login: string) {
    return login.slice(0, 2).toUpperCase();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Workspace switcher */}
      <div className="flex items-center gap-2 pl-4 pr-10 py-5">
        <div className="flex-1 min-w-0">
          <WorkspaceSwitcher currentId={workspaceId} onNavigate={onNavigate} />
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-2 overflow-y-auto">
        {isContextual ? (
          // ── CONTEXTUAL MODE ──
          <>
            <Link
              href="/dashboard"
              onClick={onNavigate}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              Вернуться на главную
            </Link>

            {workspaceName ? (
              <p className="px-3 py-1 text-xs font-semibold text-muted-foreground truncate">
                {workspaceName}
              </p>
            ) : (
              <Skeleton className="mx-3 h-4 w-3/4" />
            )}

            <Link
              href={`/workspaces/${workspaceId}/dashboard`}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === `/workspaces/${workspaceId}/dashboard`
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <House className="h-4 w-4" />
              Главная
            </Link>

            <div className="my-1 border-t" />

            {modulesLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="mx-3 h-8 rounded-md" />
                ))
              : MODULE_ORDER.filter((key) => enabledModules.includes(key)).map(
                  (key) => {
                    const meta = MODULE_META[key];
                    const href = `/workspaces/${workspaceId}/${key}`;
                    const isActive =
                      pathname === href || pathname.startsWith(href + "/");
                    return (
                      <Link
                        key={key}
                        href={href}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        {meta.icon}
                        {meta.label}
                      </Link>
                    );
                  },
                )}

            <div className="my-1 border-t" />

            <Link
              href={`/workspaces/${workspaceId}`}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === `/workspaces/${workspaceId}`
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Settings className="h-4 w-4" />
              Настройки workspace
            </Link>
          </>
        ) : (
          // ── GLOBAL MODE ──
          <>
            <Link
              href="/dashboard"
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/dashboard"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <House className="h-4 w-4" />
              Главная
            </Link>

            <Link
              href="/workspaces"
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/workspaces" ||
                  pathname.startsWith("/workspaces/")
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <LayoutDashboard className="h-4 w-4" />
              Проекты
            </Link>

            <Link
              href="/logs"
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === "/logs"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <ScrollText className="h-4 w-4" />
              Логи
            </Link>

            <Link
              href="/settings/profile"
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname.startsWith("/settings")
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Settings className="h-4 w-4" />
              Настройки профиля
            </Link>

            {userRole === "ADMIN" && (
              <Link
                href="/admin/users"
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  pathname.startsWith("/admin")
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Users className="h-4 w-4" />
                Пользователи системы
              </Link>
            )}
          </>
        )}
      </nav>

      {/* Icons row + clock + online */}
      <div className="flex flex-col items-center gap-1 px-3 py-2">
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <NotificationBell />
        </div>
        <MoscowClock />
      </div>

      {/* Online users */}
      <OnlineUsers />

      {/* User block */}
      <div className="border-t px-3 py-4">
        <div className="mb-2 flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs">
              {getInitials(userLogin)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{userLogin}</p>
            <p className="text-xs text-muted-foreground">
              {userRole === "ADMIN" ? "Администратор" : "Пользователь"}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={handleLogout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Выйти
        </Button>
      </div>
    </div>
  );
}

export function Sidebar({ userLogin, userRole }: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar — rendered by AppShell wrapper */}
      <div className="hidden md:flex md:flex-col h-full w-full">
        <SidebarContent userLogin={userLogin} userRole={userRole} />
      </div>

      {/* Mobile hamburger */}
      <div className="flex items-center border-b px-4 py-3 md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Открыть меню</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-56 p-0">
            <SidebarContent
              userLogin={userLogin}
              userRole={userRole}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <span className="ml-3 flex-1 text-sm font-semibold"></span>
        <ThemeToggle />
        <NotificationBell />
      </div>
    </>
  );
}
