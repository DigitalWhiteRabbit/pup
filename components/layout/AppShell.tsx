"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
const Sidebar = dynamic(() => import("./Sidebar").then((m) => m.Sidebar), {
  ssr: false,
});
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  userLogin: string;
  userRole: "ADMIN" | "USER";
  children: React.ReactNode;
};

export function AppShell({ userLogin, userRole, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <div
        className={`relative hidden md:flex flex-col shrink-0 border-r bg-background transition-all duration-200 overflow-hidden ${
          collapsed ? "w-0 border-r-0" : "w-56"
        }`}
      >
        {/* Collapse button inside sidebar header */}
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="absolute top-4 right-2 z-10 flex items-center justify-center h-7 w-7 rounded-md border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shadow-sm"
            title="Свернуть меню"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <Sidebar userLogin={userLogin} userRole={userRole} />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {collapsed && (
          <div className="sticky top-0 z-50 flex items-center h-12 px-3 border-b bg-background">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="flex items-center justify-center h-7 w-7 rounded-md border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shadow-sm"
              title="Развернуть меню"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
