"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { FolderKanban, Users, Settings, LogOut, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: "/projects",
    label: "Проекты",
    icon: <FolderKanban className="h-5 w-5" />,
  },
  {
    href: "/admin/users",
    label: "Пользователи",
    icon: <Users className="h-5 w-5" />,
    adminOnly: true,
  },
  {
    href: "/settings/profile",
    label: "Настройки",
    icon: <Settings className="h-5 w-5" />,
  },
];

type Props = {
  userLogin: string;
  userRole: "ADMIN" | "USER";
};

function SidebarContent({
  userLogin,
  userRole,
  onNavigate,
}: Props & { onNavigate?: () => void }) {
  const pathname = usePathname();

  const visibleItems = NAV_ITEMS.filter(
    (item) => !item.adminOnly || userRole === "ADMIN",
  );

  function handleLogout() {
    void signOut({ callbackUrl: "/login" });
  }

  function getInitials(login: string) {
    return login.slice(0, 2).toUpperCase();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="px-4 py-5">
        <span className="text-lg font-bold tracking-tight">CRM</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2">
        {visibleItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

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
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 border-r bg-background md:flex md:flex-col">
        <SidebarContent userLogin={userLogin} userRole={userRole} />
      </aside>

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
        <span className="ml-3 text-sm font-semibold">CRM</span>
      </div>
    </>
  );
}
