"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
const Sidebar = dynamic(() => import("./Sidebar").then((m) => m.Sidebar), {
  ssr: false,
});
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MobileHeader } from "./MobileHeader";
import { trackAction } from "@/lib/services/action-tracker";

// ─── Page view tracking hook ────────────────────────────────────────────────

function usePageTracking() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) {
      trackAction("page_view", pathname);
    }
  }, [pathname]);
}

type Props = {
  userLogin: string;
  userRole: "ADMIN" | "USER";
  children: React.ReactNode;
};

export function AppShell({ userLogin, userRole, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  usePageTracking();

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[200] focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded-md focus:top-2 focus:left-2"
      >
        Перейти к основному контенту
      </a>
      {/* Desktop sidebar */}
      <div
        className={`relative hidden md:flex flex-col shrink-0 border-r bg-background transition-all duration-200 overflow-hidden ${
          collapsed ? "w-0 border-r-0" : "w-56"
        }`}
      >
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="absolute top-4 right-2 z-10 flex items-center justify-center h-7 w-7 rounded-md border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shadow-sm"
            title="Свернуть меню"
            aria-label="Свернуть меню"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <Sidebar userLogin={userLogin} userRole={userRole} />
      </div>

      {/* Main content */}
      <main id="main-content" className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header with hamburger — visible only below md */}
        <MobileHeader userLogin={userLogin} userRole={userRole} />

        {/* Desktop collapsed expand button */}
        {collapsed && (
          <div className="hidden md:flex items-center h-12 px-3 border-b bg-background shrink-0">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="flex items-center justify-center h-7 w-7 rounded-md border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shadow-sm"
              title="Развернуть меню"
              aria-label="Развернуть меню"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {children}
        </div>
      </main>
    </div>
  );
}
